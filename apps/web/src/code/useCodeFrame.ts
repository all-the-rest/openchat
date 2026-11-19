import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import type { CodeStatusResponse } from "@openchat/contracts"
import { useLocation } from "react-router-dom"
import { api } from "../api/client"
import { useEventStreamOrNull } from "../api/events"
import { useMediaQuery } from "../lib/useMediaQuery"
import { useOnline } from "../lib/useOnline"
import { useSurfaceOrNull } from "./SurfaceProvider"
import { codeDeepLink } from "./surface"

/** Desktop breakpoint, matching Tailwind's `lg` (spec 08). */
const WIDE_QUERY = "(min-width: 1024px)"

/** A frame that never fires `load` is treated as blocked (spec 13). */
export const CODE_LOAD_TIMEOUT_MS = 15_000

/**
 * While the surface is visible, the Code host status is re-read at this
 * interval. The BFF caches the probe for 10 s, so this is one upstream probe
 * per 10 s at most. Hidden (Chat) the timer is cleared; returning refreshes
 * once and restarts it.
 */
export const CODE_STATUS_POLL_MS = 10_000

/**
 * A frame URL that never loaded is only reused for this long. The BFF mints
 * tickets with a 60 s lifetime, so a ticket minted before a switch away and
 * back is reminted instead of used after it may have expired. A frame that
 * did load keeps its own host session and is never reminted for a switch.
 */
export const CODE_TICKET_REUSE_MS = 55_000

export type Phase = "loading" | "ready" | "down" | "signedOut" | "blocked"
export type Failure = "ticket" | "status"

export interface CodeFrameValue {
  online: boolean
  wide: boolean
  status: CodeStatusResponse | null
  frameUrl: string | null
  newTabUrl: string | null
  phase: Phase
  failure: Failure
  loaded: boolean
  barRef: RefObject<HTMLDivElement | null>
  frameRef: RefObject<HTMLIFrameElement | null>
  reload(): void
  markLoaded(): void
}

/**
 * Owns the Code frame's lifecycle: one ticket pair per activation unless a
 * live frame can be reused, a status read that pauses while the surface is
 * hidden, and recovery from a host or stream transition. Rendering stays in
 * `CodePage`; this hook has no UI.
 *
 * `active` is the surface switch, not a mount switch. While the owner is in
 * Chat the frame stays mounted, so an unsent prompt inside it, its document
 * state and its scroll position survive, and returning never mints a new
 * ticket or starts a new host session.
 */
export function useCodeFrame({
  active,
  loadTimeoutMs = CODE_LOAD_TIMEOUT_MS,
}: {
  active: boolean
  loadTimeoutMs?: number
}): CodeFrameValue {
  const location = useLocation()
  const online = useOnline()
  const wide = useMediaQuery(WIDE_QUERY)
  const surface = useSurfaceOrNull()
  const stream = useEventStreamOrNull()
  const next = codeDeepLink(location.pathname)

  const [status, setStatus] = useState<CodeStatusResponse | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [newTabUrl, setNewTabUrl] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("loading")
  const [failure, setFailure] = useState<Failure>("status")
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const barRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  /**
   * The Code host path of the next mint. It only follows the app route while
   * the surface is visible: in Chat the route is a chat path, and a switch
   * back must not mint for `/` when the frame already lives somewhere else.
   */
  const deepLink = useRef(next)
  const minted = useRef<{ attempt: number; at: number } | null>(null)
  const frameUrlRef = useRef<string | null>(null)
  const loadedRef = useRef(false)
  const phaseRef = useRef<Phase>("loading")
  const failureRef = useRef<Failure>("status")
  const lastReconnect = useRef(0)
  const previousHost = useRef<boolean | null | undefined>(undefined)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])
  useEffect(() => {
    failureRef.current = failure
  }, [failure])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])

  const showFrame = useCallback((url: string | null) => {
    frameUrlRef.current = url
    setFrameUrl(url)
  }, [])

  /**
   * One status read that only ever *helps*: it updates the warning and
   * recovers a surface that is down with no frame. It never tears down a
   * frame that is already up.
   */
  const refreshStatus = useCallback(async () => {
    let value: CodeStatusResponse | null = null
    try {
      value = await api.codeStatus()
    } catch {
      value = null
    }
    setStatus(value)
    if (!value || value.reachable === false) {
      if (frameUrlRef.current === null && !loadedRef.current) {
        setFailure("status")
        setPhase("down")
      }
      return
    }
    // The host is back and there is nothing to show yet: retry automatically
    // instead of waiting for the owner to find Reload.
    if (
      phaseRef.current === "down" &&
      failureRef.current === "status" &&
      frameUrlRef.current === null
    ) {
      setAttempt((current) => current + 1)
    }
  }, [])

  // Follow `/code/*` deep links only while the surface is visible. After the
  // first mint the frame owns its route; this ref is a fallback entry point.
  useEffect(() => {
    if (active) deepLink.current = next
  }, [active, next])

  // Mint only when there is no reusable frame. A loaded frame keeps its host
  // session (the ticket was single use and is already redeemed); an unloaded
  // one is reused only while its ticket can still be valid.
  useEffect(() => {
    if (!active || !online) return
    const current = minted.current
    const reusable =
      current !== null &&
      current.attempt === attempt &&
      (loadedRef.current || Date.now() - current.at < CODE_TICKET_REUSE_MS)
    if (reusable) {
      // Coming back: resume with one fresh status read, no ticket.
      void refreshStatus()
      return
    }

    let cancelled = false
    setPhase("loading")
    showFrame(null)
    loadedRef.current = false
    setLoaded(false)

    void (async () => {
      // One ticket for the frame and one for "open in a new tab": the exchange
      // is single use, so a shared URL would 401 in the second tab.
      const [frame, tab, probe] = await Promise.allSettled([
        api.codeTicket(deepLink.current),
        api.codeTicket(deepLink.current),
        api.codeStatus(),
      ])
      if (cancelled) return
      if (probe.status === "fulfilled") setStatus(probe.value)
      if (frame.status === "rejected") {
        setFailure("ticket")
        setPhase("down")
        return
      }
      if (probe.status === "rejected" || probe.value.reachable === false) {
        setFailure("status")
        setPhase("down")
        return
      }
      minted.current = { attempt, at: Date.now() }
      showFrame(frame.value.url)
      setNewTabUrl(tab.status === "fulfilled" ? tab.value.url : null)
      setPhase("ready")
    })()

    return () => {
      cancelled = true
    }
  }, [active, online, attempt, refreshStatus, showFrame])

  // Offline is the one case that drops the frame: nothing can be reused while
  // the network is gone, so reconnect mints a fresh pair.
  useEffect(() => {
    if (online) return
    minted.current = null
    frameUrlRef.current = null
    loadedRef.current = false
    setFrameUrl(null)
    setLoaded(false)
  }, [online])

  // A framed Code UI that never fires `load` is the only blocked case this side
  // can see (a frame refused by a policy fires `load`, see implementation 07).
  // The narrow layout mounts no frame at all, so it never starts this timer,
  // and a hidden surface does not spend its 15 s while the owner is in Chat.
  useEffect(() => {
    if (!active || !wide || phase !== "ready" || loaded || !frameUrl) return
    const timer = window.setTimeout(() => setPhase("blocked"), loadTimeoutMs)
    return () => window.clearTimeout(timer)
  }, [active, wide, phase, loaded, frameUrl, loadTimeoutMs])

  // Status polling runs only while the surface is visible. Hiding clears the
  // interval; the mint effect's reuse branch refreshes once on return.
  useEffect(() => {
    if (!active || !online) return
    const timer = window.setInterval(() => void refreshStatus(), CODE_STATUS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [active, online, refreshStatus])

  // The app already exposes the host/stream state. A reopened event stream or
  // a host recovering from unreachable is a cheaper recovery signal than the
  // next poll tick, and it also covers "the tunnel came back".
  useEffect(() => {
    const reconnect = stream?.reconnect ?? 0
    const previous = previousHost.current
    previousHost.current = surface?.hostReachable
    if (!active || !online) return
    const reconnected = reconnect > 0 && reconnect !== lastReconnect.current
    if (reconnected) lastReconnect.current = reconnect
    const recovered = previous === false && surface?.hostReachable === true
    if (reconnected || recovered) void refreshStatus()
  }, [active, online, stream?.reconnect, surface?.hostReachable, refreshStatus])

  const codeOrigin = useMemo(() => {
    if (!frameUrl) return null
    try {
      return new URL(frameUrl).origin
    } catch {
      return null
    }
  }, [frameUrl])

  // The frame cannot be inspected; it posts an explicit unauthenticated state.
  useEffect(() => {
    if (!codeOrigin) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== codeOrigin) return
      const data = event.data as { type?: unknown; state?: unknown } | null
      if (!data || data.type !== "openchat:code-state" || data.state !== "unauthenticated") return
      setPhase("signedOut")
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [codeOrigin])

  // Escape returns focus to the bar. A key pressed inside the cross-origin
  // frame never reaches this window, so the app only handles its own side.
  // While hidden the bar is not rendered and must not steal focus from Chat.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const bar = barRef.current
      if (!bar) return
      const focused = document.activeElement
      if (focused instanceof Node && bar.contains(focused)) return
      event.preventDefault()
      bar.focus()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active])

  const markLoaded = useCallback(() => {
    loadedRef.current = true
    setLoaded(true)
  }, [])

  return {
    online,
    wide,
    status,
    frameUrl,
    newTabUrl,
    phase,
    failure,
    loaded,
    barRef,
    frameRef,
    reload,
    markLoaded,
  }
}
