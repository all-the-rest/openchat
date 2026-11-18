import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { CodeStatusResponse } from "@openchat/contracts"
import { useLocation } from "react-router-dom"
import { api } from "../api/client"
import { AlertIcon } from "../components/icons"
import type { MessageKey } from "../i18n"
import { useT } from "../i18n/provider"
import { useMediaQuery } from "../lib/useMediaQuery"
import { useOnline } from "../lib/useOnline"
import { SurfaceSwitch } from "./SurfaceSwitch"
import { codeDeepLink } from "./surface"

/** Desktop breakpoint, matching Tailwind's `lg` (spec 08). */
const WIDE_QUERY = "(min-width: 1024px)"

/** A frame that never fires `load` is treated as blocked (spec 13). */
export const CODE_LOAD_TIMEOUT_MS = 15_000

/**
 * Only clipboard access is delegated: the Code UI copies code and output and
 * pastes into its editor. Camera, microphone, geolocation and popups stay with
 * the app and are not granted to the frame.
 */
export const CODE_FRAME_ALLOW = "clipboard-read; clipboard-write"

type Phase = "loading" | "ready" | "down" | "signedOut" | "blocked"
type Failure = "ticket" | "status"

const STATE_KEYS: Record<Phase | "offline", MessageKey> = {
  loading: "code.state.loading",
  ready: "code.state.ready",
  down: "code.state.down",
  signedOut: "code.state.signedOut",
  blocked: "code.state.blocked",
  offline: "code.state.offline",
}

function Panel({
  title,
  body,
  alert = false,
  children,
}: {
  title: string
  body: string
  alert?: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10">
      <div
        role={alert ? "alert" : undefined}
        className="w-full max-w-md rounded-card border border-subtle bg-surface p-5 text-center"
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted">{body}</p>
        {children ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * `/code` and `/code/*` — the Code host in a frame with a slim control bar.
 * The frame owns its own navigation; the app only mints the signed entry URL,
 * reports connection states and keeps focus reachable.
 */
export function CodePage({ loadTimeoutMs = CODE_LOAD_TIMEOUT_MS }: { loadTimeoutMs?: number }) {
  const t = useT()
  const location = useLocation()
  const online = useOnline()
  const wide = useMediaQuery(WIDE_QUERY)
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

  const reload = useCallback(() => setAttempt((value) => value + 1), [])

  // One ticket for the frame and one for "open in a new tab": the exchange is
  // single use, so a shared URL would 401 in the second tab.
  useEffect(() => {
    let active = true
    setPhase("loading")
    setStatus(null)
    setFrameUrl(null)
    setNewTabUrl(null)
    setLoaded(false)
    if (!online) {
      return () => {
        active = false
      }
    }

    void (async () => {
      const [frame, tab, probe] = await Promise.allSettled([
        api.codeTicket(next),
        api.codeTicket(next),
        api.codeStatus(),
      ])
      if (!active) return
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
      setFrameUrl(frame.value.url)
      setNewTabUrl(tab.status === "fulfilled" ? tab.value.url : null)
      setPhase("ready")
    })()

    return () => {
      active = false
    }
  }, [next, attempt, online])

  // A framed Code UI that never loads is usually blocked by a frame policy.
  useEffect(() => {
    if (phase !== "ready" || loaded || !frameUrl) return
    const timer = window.setTimeout(() => setPhase("blocked"), loadTimeoutMs)
    return () => window.clearTimeout(timer)
  }, [phase, loaded, frameUrl, loadTimeoutMs])

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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const bar = barRef.current
      if (!bar) return
      const active = document.activeElement
      if (active instanceof Node && bar.contains(active)) return
      event.preventDefault()
      bar.focus()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const frameVisible = wide && online && phase === "ready"
  const state: Phase | "offline" = !online
    ? "offline"
    : phase === "ready" && !loaded
      ? "loading"
      : phase

  const newTabLink = (short: boolean, testId = "code-new-tab") => (
    <a
      href={newTabUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      title={t("code.openNewTab")}
      aria-disabled={newTabUrl ? undefined : true}
      onClick={newTabUrl ? undefined : (event) => event.preventDefault()}
      className={`btn btn-sm ${newTabUrl ? "btn-ghost" : "btn-disabled btn-ghost"}`}
    >
      {short ? t("code.openNewTabShort") : t("code.openNewTab")}
      <span className="sr-only"> ({t("code.opensInNewTab")})</span>
    </a>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <div
        ref={barRef}
        role="region"
        tabIndex={-1}
        aria-label={t("code.barLabel")}
        data-testid="code-bar"
        className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-2 py-1 outline-none"
      >
        <SurfaceSwitch />
        <span
          role="status"
          aria-live="polite"
          data-testid="code-state"
          className="flex items-center gap-1.5 text-xs text-muted"
        >
          {state === "loading" ? (
            <span className="loading loading-spinner loading-xs" aria-hidden="true" />
          ) : null}
          {t(STATE_KEYS[state])}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="code-reload"
          onClick={reload}
          disabled={!online}
          aria-label={t("code.reload")}
          title={t("code.reload")}
          className="btn btn-ghost btn-sm"
        >
          {t("code.reload")}
        </button>
        {newTabLink(false)}
        {frameVisible ? (
          <button
            type="button"
            data-testid="code-focus-frame"
            onClick={() => frameRef.current?.focus()}
            className="btn btn-ghost btn-sm"
          >
            {t("code.focusFrame")}
          </button>
        ) : null}
      </div>

      {status && status.reachable && status.matches === false ? (
        <p
          role="status"
          data-testid="code-version-warning"
          className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <AlertIcon className="size-4 shrink-0" />
          {t("code.versionMismatch", {
            version: status.version ?? "?",
            expected: status.expectedVersion,
          })}
        </p>
      ) : null}

      {!wide ? (
        <Panel title={t("code.mobileTitle")} body={t("code.mobileBody")}>
          {newTabLink(true, "code-new-tab-fallback")}
        </Panel>
      ) : !online ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <p
            role="alert"
            data-testid="code-offline"
            className="border-b border-subtle bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            {t("code.offlineBody")}
          </p>
        </div>
      ) : phase === "down" ? (
        <Panel
          alert
          title={t("code.downTitle")}
          body={failure === "ticket" ? t("code.downTicket") : t("code.downStatus")}
        >
          <p className="w-full text-xs text-muted">
            {status?.expectedVersion
              ? t("code.expectedVersion", { version: status.expectedVersion })
              : null}
          </p>
          <button type="button" onClick={reload} className="btn btn-primary btn-sm">
            {t("code.retry")}
          </button>
        </Panel>
      ) : phase === "signedOut" ? (
        <Panel title={t("code.signedOutTitle")} body={t("code.signedOutBody")}>
          <button
            type="button"
            data-testid="code-sign-in"
            onClick={reload}
            className="btn btn-primary btn-sm"
          >
            {t("code.signIn")}
          </button>
        </Panel>
      ) : phase === "blocked" ? (
        <Panel title={t("code.blockedTitle")} body={t("code.blockedBody")}>
          {newTabLink(false, "code-new-tab-fallback")}
        </Panel>
      ) : (
        <div data-testid="code-frame-area" className="relative flex min-h-0 flex-1">
          {frameUrl ? (
            <iframe
              ref={frameRef}
              src={frameUrl}
              title={t("code.frameTitle")}
              allow={CODE_FRAME_ALLOW}
              data-testid="code-frame"
              onLoad={() => setLoaded(true)}
              className="h-full w-full border-0 bg-surface"
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
