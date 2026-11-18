import type { ArtifactResponse } from "@openchat/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, api } from "../api/client"
import type { BridgeStatus } from "./bridge"
import { ARTIFACT_REFRESH_MARGIN_MS, needsFreshURL } from "./files"

/**
 * A frame that fired `load` but did not send `artifact:ready` within this
 * window is either a stale signed URL (the artifact host answered 403 with a
 * JSON body) or a generation-1 document that has no bridge shim at all.
 *
 * The two are indistinguishable from the parent, because a sandboxed frame
 * without `allow-same-origin` exposes no document. 1.5 s is three times the
 * bridge's 1 s init-repost interval, so a healthy generation-2 document has
 * answered long before it, while a refused URL gets replaced quickly. The
 * replacement is attempted once; a second silent frame is accepted as
 * generation 1 instead of being declared an error.
 */
export const ARTIFACT_HANDSHAKE_GRACE_MS = 1_500

export type ArtifactPhase = "loading" | "ready" | "missing" | "error"

export interface ArtifactDocumentOptions {
  id: string
  /** The bridge's state for the mounted frame. */
  handshake: BridgeStatus
  /** A frame that never fires `load` is a refused URL after this long. */
  loadTimeoutMs: number
  /** Grace after a load without an `artifact:ready` message. */
  handshakeGraceMs: number
}

export interface ArtifactDocument {
  phase: ArtifactPhase
  meta: ArtifactResponse | null
  /** The current frame fired `load`. */
  loaded: boolean
  /** One recovery read failed or a frame never loaded twice. */
  frameFailed: boolean
  /** The current frame is accepted as a generation-1 document. */
  legacy: boolean
  /** The pre-expiry refresh failed; the frame keeps its last URL. */
  refreshFailed: boolean
  /** Full re-read; the error and stale panels' Retry. */
  reload(): void
  onLoad(): void
  onFrameError(): void
  /** The frame was remounted with the same URL by Reset. */
  onFrameReset(): void
  dismissRefreshFailure(): void
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

/**
 * Metadata, URL freshness and the "loaded something that is not the artifact"
 * state machine for one artifact. The viewer only renders what this returns:
 * the same callbacks serve the initial read, the no-load timeout, the silent
 * handshake grace and the stale panel's Retry, so no second path can disagree
 * about whether the frame is the document.
 */
export function useArtifactDocument(options: ArtifactDocumentOptions): ArtifactDocument {
  const { id, handshake, loadTimeoutMs, handshakeGraceMs } = options
  const [phase, setPhase] = useState<ArtifactPhase>("loading")
  const [meta, setMeta] = useState<ArtifactResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [frameFailed, setFrameFailed] = useState(false)
  const [legacy, setLegacy] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)

  const alive = useRef(true)
  const recovered = useRef(0)
  const recovering = useRef(false)
  const refreshedURLs = useRef(new Set<string>())

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // One metadata read per attempt. A URL that arrives at the edge of its
  // lifetime is replaced by a second read, so the frame never starts on a link
  // that is about to expire.
  useEffect(() => {
    let active = true
    setPhase("loading")
    setMeta(null)
    setFrameFailed(false)
    setLoaded(false)
    setLegacy(false)
    setRefreshFailed(false)
    recovered.current = 0
    refreshedURLs.current.clear()
    recovering.current = false

    if (!id) {
      setPhase("missing")
      return () => {
        active = false
      }
    }

    void (async () => {
      try {
        let next = await api.artifact(id)
        if (needsFreshURL(next.expiresAt) && !refreshedURLs.current.has(next.url)) {
          refreshedURLs.current.add(next.url)
          next = await api.artifact(id)
        }
        if (!active) return
        setMeta(next)
        setPhase("ready")
      } catch (error) {
        if (!active) return
        setPhase(isNotFound(error) ? "missing" : "error")
      }
    })()

    return () => {
      active = false
    }
  }, [id, attempt])

  // A frame that reports an error, or never loads at all, is the only signal a
  // cross-origin frame gives (an HTTP 403 is not readable from the parent).
  // One recovery read, then the recoverable panel.
  const recover = useCallback(async () => {
    if (!meta || recovering.current) return
    // Keyed on the attempt, not the URL: a recovery mints a fresh URL, so a
    // URL-keyed guard would re-read forever against a host that keeps failing.
    if (recovered.current >= 1) {
      setFrameFailed(true)
      return
    }
    recovered.current += 1
    recovering.current = true
    try {
      const next = await api.artifact(id)
      if (!alive.current) return
      setMeta(next)
      setFrameFailed(false)
      setLoaded(false)
      setLegacy(false)
    } catch {
      if (alive.current) setFrameFailed(true)
    } finally {
      recovering.current = false
    }
  }, [id, meta])

  // The frame loaded. A generation-2 document answers the bridge shortly after;
  // a silent frame gets one automatic re-mint before it is accepted as
  // generation 1. Never a second error, because the two shapes look identical.
  useEffect(() => {
    if (phase !== "ready" || frameFailed || !meta) return
    if (handshake === "ready" || legacy) return

    if (!loaded) {
      const timer = window.setTimeout(() => void recover(), loadTimeoutMs)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setTimeout(() => {
      if (recovered.current >= 1) setLegacy(true)
      else void recover()
    }, handshakeGraceMs)
    return () => window.clearTimeout(timer)
  }, [phase, frameFailed, meta, loaded, handshake, legacy, recover, loadTimeoutMs, handshakeGraceMs])

  // Refresh shortly before the signature expires. The frame keeps its last
  // working URL if this read fails; a later reload asks again.
  useEffect(() => {
    if (phase !== "ready" || !meta) return
    const expires = Date.parse(meta.expiresAt)
    if (!Number.isFinite(expires)) return
    const delay = expires - Date.now() - ARTIFACT_REFRESH_MARGIN_MS
    if (delay <= 0) return
    const timer = window.setTimeout(() => {
      void api
        .artifact(id)
        .then((next) => {
          if (!alive.current) return
          setMeta(next)
          setLoaded(false)
          setRefreshFailed(false)
        })
        .catch(() => {
          if (alive.current) setRefreshFailed(true)
        })
    }, Math.min(delay, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [phase, meta, id])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])
  const onLoad = useCallback(() => setLoaded(true), [])
  const onFrameError = useCallback(() => void recover(), [recover])
  const onFrameReset = useCallback(() => {
    setLoaded(false)
    setFrameFailed(false)
    setLegacy(false)
  }, [])
  const dismissRefreshFailure = useCallback(() => setRefreshFailed(false), [])

  return {
    phase,
    meta,
    loaded,
    frameFailed,
    legacy,
    refreshFailed,
    reload,
    onLoad,
    onFrameError,
    onFrameReset,
    dismissRefreshFailure,
  }
}
