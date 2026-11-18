import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import type { Locale } from "../i18n"
import type { Theme } from "../theme/provider"

/**
 * Viewer side of the artifact `postMessage` bridge (04-artifact-sandbox.md,
 * 07-artifact-runtime.md "Runtime API"). The frame is sandboxed without
 * `allow-same-origin`, so its origin is the string `"null"`; identity is
 * `event.source === iframe.contentWindow` plus a per-frame nonce, never
 * `event.origin`.
 */

/** Repost `artifact:init` when no `artifact:ready` arrived in this window. */
export const ARTIFACT_INIT_TIMEOUT_MS = 1_000
/** The docs allow two reposts; after that the artifact stays mute. */
export const ARTIFACT_INIT_MAX_REPOSTS = 2

/** Height bounds for `artifact:resize`; the frame scrolls above the max. */
export const ARTIFACT_RESIZE_MIN = 80
export const ARTIFACT_RESIZE_MAX = 4_000

/** One result, serialised as JSON, may not exceed 64 KiB. */
export const ARTIFACT_RESULT_MAX_BYTES = 64 * 1024
/** At most one accepted result per window, per viewer. */
export const ARTIFACT_RESULT_INTERVAL_MS = 500
/** A title is a label for the draft, not a second payload. */
export const ARTIFACT_RESULT_TITLE_MAX = 200

export type BridgeStatus = "idle" | "waiting" | "ready"

/** The validated payload the artifact hands back. It is never HTML. */
export interface ArtifactResult {
  title?: string
  text?: string
  data?: unknown
}

export interface ArtifactBridgeOptions {
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Sent in `artifact:init` so the artifact can identify itself. */
  artifactId: string
  theme: Theme
  locale: Locale
  /** Bumped by the viewer when the frame is reset; mints a new nonce. */
  epoch: number
  onResult?(result: ArtifactResult): void
}

export interface ArtifactBridge {
  status: BridgeStatus
  /** Last accepted height, or `null` before the artifact reports one. */
  height: number | null
  nonce: string
  /** Call from the iframe's `load` handler; posts `artifact:init`. */
  onLoad(): void
  /**
   * Ask a ready artifact to restart itself (`artifact:reset`). Returns
   * `false` when the frame never completed the handshake, so the viewer can
   * remount it with the same URL instead.
   */
  reset(): boolean
}

/**
 * 32 hex characters. The nonce proves the sender is the frame the viewer
 * created; it is not a credential and grants nothing on its own.
 */
export function createNonce(): string {
  const bytes = new Uint8Array(16)
  const crypto = globalThis.crypto
  if (crypto && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Integer pixels inside the documented band. A non-finite input is not a
 * height: fall back to the minimum instead of letting `NaN` reach the style.
 */
export function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return ARTIFACT_RESIZE_MIN
  const rounded = Math.round(value)
  if (rounded < ARTIFACT_RESIZE_MIN) return ARTIFACT_RESIZE_MIN
  if (rounded > ARTIFACT_RESIZE_MAX) return ARTIFACT_RESIZE_MAX
  return rounded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Shape check plus the 64 KiB ceiling. Returns the accepted result or `null`;
 * unknown fields are dropped, wrong field types reject the whole message.
 */
export function readResult(
  value: unknown,
): { result: ArtifactResult; bytes: number } | null {
  if (!isRecord(value)) return null
  const result: ArtifactResult = {}
  if ("title" in value) {
    if (typeof value.title !== "string") return null
    result.title = [...value.title].slice(0, ARTIFACT_RESULT_TITLE_MAX).join("")
  }
  if ("text" in value) {
    if (typeof value.text !== "string") return null
    result.text = value.text
  }
  if ("data" in value) result.data = value.data
  let json: string
  try {
    json = JSON.stringify(result)
  } catch {
    return null
  }
  if (typeof json !== "string") return null
  const bytes = new TextEncoder().encode(json).length
  return { result, bytes }
}

/**
 * The bridge state machine. Everything the hook owns is scoped to one nonce,
 * so a reset (new epoch) starts from a clean slate and late messages from the
 * previous frame cannot land in the new one.
 */
export function useArtifactBridge(options: ArtifactBridgeOptions): ArtifactBridge {
  const { frameRef, artifactId, theme, locale, epoch } = options
  const nonce = useMemo(() => createNonce(), [epoch])

  const [status, setStatus] = useState<BridgeStatus>("idle")
  const [height, setHeight] = useState<number | null>(null)

  const statusRef = useRef<BridgeStatus>("idle")
  const lastResultAt = useRef(Number.NEGATIVE_INFINITY)
  const timers = useRef(new Set<number>())
  const onResult = useRef(options.onResult)
  onResult.current = options.onResult

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current.clear()
  }, [])

  // A new frame instance (reset) starts over: idle, no height, no rate debt.
  useEffect(() => {
    statusRef.current = "idle"
    lastResultAt.current = Number.NEGATIVE_INFINITY
    setStatus("idle")
    setHeight(null)
    return clearTimers
  }, [nonce, clearTimers])

  const postInit = useCallback(
    (attempt: number) => {
      const frame = frameRef.current
      frame?.contentWindow?.postMessage(
        { type: "artifact:init", id: artifactId, nonce, theme, locale },
        "*",
      )
      if (attempt >= ARTIFACT_INIT_MAX_REPOSTS) return
      const timer = window.setTimeout(() => {
        timers.current.delete(timer)
        if (statusRef.current === "ready") return
        postInit(attempt + 1)
      }, ARTIFACT_INIT_TIMEOUT_MS)
      timers.current.add(timer)
    },
    [artifactId, frameRef, locale, nonce, theme],
  )

  const onLoad = useCallback(() => {
    clearTimers()
    statusRef.current = "waiting"
    setStatus("waiting")
    postInit(0)
  }, [clearTimers, postInit])

  const reset = useCallback(() => {
    if (statusRef.current !== "ready") return false
    const frame = frameRef.current
    if (!frame?.contentWindow) return false
    frame.contentWindow.postMessage({ type: "artifact:reset", nonce }, "*")
    return true
  }, [frameRef, nonce])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      // Identity, not origin: an opaque sandboxed frame reports "null".
      if (!frame || event.source !== frame.contentWindow) return
      const data: unknown = event.data
      if (!isRecord(data) || typeof data.type !== "string") return
      if (data.nonce !== nonce) return

      if (data.type === "artifact:ready") {
        clearTimers()
        statusRef.current = "ready"
        setStatus("ready")
        return
      }

      if (data.type === "artifact:resize") {
        if (typeof data.height !== "number" || !Number.isFinite(data.height)) return
        setHeight(clampHeight(data.height))
        return
      }

      if (data.type === "artifact:result") {
        const accepted = readResult(data)
        if (!accepted || accepted.bytes > ARTIFACT_RESULT_MAX_BYTES) return
        const now = Date.now()
        if (now - lastResultAt.current < ARTIFACT_RESULT_INTERVAL_MS) return
        lastResultAt.current = now
        onResult.current?.(accepted.result)
      }
      // Unknown types, including a future `artifact:error`, are dropped.
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [clearTimers, frameRef, nonce])

  return { status, height, nonce, onLoad, reset }
}
