import type { ReactNode } from "react"
import { AlertIcon } from "../components/icons"
import type { MessageKey } from "../i18n"
import { useT } from "../i18n/provider"
import { SurfaceSwitch } from "./SurfaceSwitch"
import {
  CODE_LOAD_TIMEOUT_MS,
  useCodeFrame,
  type Phase,
} from "./useCodeFrame"

export {
  CODE_LOAD_TIMEOUT_MS,
  CODE_STATUS_POLL_MS,
  CODE_TICKET_REUSE_MS,
} from "./useCodeFrame"

/**
 * Only copy-out is delegated: the Code UI copies code and output. Reading the
 * clipboard is the app's job (paste into the composer), and camera, microphone,
 * geolocation and popups stay with the app, never the frame.
 */
export const CODE_FRAME_ALLOW = "clipboard-write"

const STATE_KEYS: Record<Phase | "offline" | "narrow", MessageKey> = {
  loading: "code.state.loading",
  ready: "code.state.ready",
  down: "code.state.down",
  signedOut: "code.state.signedOut",
  blocked: "code.state.blocked",
  offline: "code.state.offline",
  narrow: "code.state.narrow",
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
 *
 * `active` is the surface switch, not a mount switch: while the owner is in
 * Chat this component stays mounted with its frame hidden, so an unsent prompt
 * inside the frame, its document state and its scroll position survive the
 * round trip and returning never mints a new ticket or starts a new host
 * session. Chat-only work (status polling, focus handling) is paused while
 * hidden; the state machine lives in `useCodeFrame`.
 */
export function CodePage({
  loadTimeoutMs = CODE_LOAD_TIMEOUT_MS,
  active = true,
}: {
  loadTimeoutMs?: number
  active?: boolean
}) {
  const t = useT()
  const {
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
  } = useCodeFrame({ active, loadTimeoutMs })

  const frameVisible = active && wide && online && phase === "ready" && frameUrl !== null
  // Below `lg` no frame is mounted, so neither "Loading…" nor "Embedding
  // blocked" describes that layout: it gets its own explicit state.
  const state: Phase | "offline" | "narrow" = !online
    ? "offline"
    : !wide
      ? "narrow"
      : phase === "ready" && !loaded
        ? "loading"
        : phase
  const ticketFailure: boolean = failure === "ticket"
  // The panel already says the mint failed; the bar must not claim the Code
  // host is unreachable when it was never asked.
  const stateKey: MessageKey =
    ticketFailure && state === "down" ? "code.state.ticket" : STATE_KEYS[state]

  // While hidden only the frame area survives; the bar, panels and the switch
  // are not rendered, so Chat still has exactly one surface switch and the
  // hidden surface contributes no banner, no button and no tab target.
  const showPanel =
    active &&
    (!wide || !online || phase === "down" || phase === "signedOut" || phase === "blocked")

  const newTabLink = (short: boolean, testId = "code-new-tab") => (
    <a
      href={newTabUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      title={t("code.openNewTab")}
      aria-disabled={newTabUrl ? undefined : true}
      onClick={newTabUrl ? undefined : (event) => event.preventDefault()}
      className={`btn btn-sm ${newTabUrl ? "btn-outline" : "btn-disabled btn-outline"}`}
    >
      {short ? t("code.openNewTabShort") : t("code.openNewTab")}
      <span className="sr-only"> ({t("code.opensInNewTab")})</span>
    </a>
  )

  const ticketTitle = ticketFailure ? t("code.ticketTitle") : t("code.downTitle")
  const ticketBody = ticketFailure ? t("code.ticketBody") : t("code.downStatus")

  return (
    <div
      data-testid="code-surface"
      hidden={!active}
      inert={!active}
      aria-hidden={active ? undefined : true}
      className={active ? "flex min-h-0 flex-1 flex-col bg-app" : "hidden"}
    >
      {active ? (
        <div
          ref={barRef}
          role="banner"
          tabIndex={-1}
          aria-label={t("code.barLabel")}
          data-testid="code-bar"
          className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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
            {t(stateKey)}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="code-reload"
            onClick={reload}
            disabled={!online}
            aria-label={t("code.reload")}
            title={t("code.reload")}
            className="btn btn-outline btn-sm"
          >
            {t("code.reload")}
          </button>
          {newTabLink(!wide)}
          {frameVisible ? (
            <button
              type="button"
              data-testid="code-focus-frame"
              onClick={() => frameRef.current?.focus()}
              className="btn btn-outline btn-sm"
            >
              {t("code.focusFrame")}
            </button>
          ) : null}
        </div>
      ) : null}

      {active && status && status.reachable && status.matches === false ? (
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

      {showPanel ? (
        !wide ? (
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
          <Panel alert title={ticketTitle} body={ticketBody}>
            {!ticketFailure && status?.expectedVersion ? (
              <p className="w-full text-xs text-muted">
                {t("code.expectedVersion", { version: status.expectedVersion })}
              </p>
            ) : null}
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
        ) : (
          <Panel title={t("code.blockedTitle")} body={t("code.blockedBody")}>
            {newTabLink(false, "code-new-tab-fallback")}
          </Panel>
        )
      ) : (
        <div data-testid="code-frame-area" className="relative flex min-h-0 flex-1">
          {frameUrl !== null ? (
            <iframe
              ref={frameRef}
              src={frameUrl}
              title={t("code.frameTitle")}
              allow={CODE_FRAME_ALLOW}
              tabIndex={active ? undefined : -1}
              data-testid="code-frame"
              onLoad={markLoaded}
              className="h-full w-full border-0 bg-surface"
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
