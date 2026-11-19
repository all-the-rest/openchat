import type { PermissionDecision } from "@openchat/contracts"
import { useEffect, useId, useRef } from "react"
import { useT } from "../i18n/provider"
import type { PermissionValue } from "./permissions"

/**
 * Approval above the composer. Real buttons keep every action in the tab
 * order, and the composer is disabled while a request is outstanding so a
 * prompt cannot be sent before the user decides.
 *
 * The card is an `alertdialog` (spec 09): it takes focus when a request
 * appears and hands focus back to the previously focused element once a
 * decision is made.
 */
export function PermissionCard({ value }: { value: PermissionValue }) {
  const t = useT()
  const baseID = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  const restoreOnSettle = useRef(false)
  const hasRequests = value.requests.length > 0

  // Track focus continuously. By the time the card's effect runs, the same
  // state update has disabled the composer, which blurs it to <body> during
  // React's commit — reading document.activeElement there is too late.
  useEffect(() => {
    const track = (event: FocusEvent) => {
      const el = event.target
      if (el instanceof HTMLElement && el !== document.body && !cardRef.current?.contains(el)) {
        lastFocused.current = el
      }
    }
    document.addEventListener("focusin", track)
    return () => document.removeEventListener("focusin", track)
  }, [])

  useEffect(() => {
    if (hasRequests) {
      // Use the continuously tracked element, not document.activeElement.
      previousFocus.current = lastFocused.current
      // Focus the dialog container rather than a button: a screen reader reads
      // the labelled alert first, and the next Tab still lands on the first
      // decision button (which stays in the natural tab order).
      cardRef.current?.focus()
      return
    }
    // The composer is disabled while a request is outstanding, so focusing
    // its trigger synchronously in `decide()` is a no-op. Restore only after
    // the request has settled and the previously focused control re-enabled.
    if (!restoreOnSettle.current) return
    restoreOnSettle.current = false
    const target = previousFocus.current
    previousFocus.current = null
    if (target?.isConnected && !target.hasAttribute("disabled")) target.focus()
  }, [hasRequests])

  const decide = (requestID: string, decision: PermissionDecision) => {
    restoreOnSettle.current = true
    void value.reply(requestID, decision)
  }

  if (!hasRequests) return null

  const first = value.requests[0]!
  const labelID = `${baseID}-title-${first.id}`
  const descriptionID = `${baseID}-action-${first.id}`

  return (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-labelledby={labelID}
      aria-describedby={descriptionID}
      tabIndex={-1}
      data-testid="permission-card"
      className="mb-2 flex flex-col gap-2"
    >
      {value.requests.map((request) => (
        <div
          key={request.id}
          data-testid="permission-request"
          className="rounded-card border border-subtle bg-surface p-3 text-sm"
        >
          <p id={`${baseID}-title-${request.id}`} className="font-semibold">{t("chat.permissionTitle")}</p>
          <p className="mt-1">{t("chat.permissionTool", { tool: request.tool })}</p>
          <p id={`${baseID}-action-${request.id}`} className="break-words">{request.action}</p>
          {request.resources.length > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {t("chat.permissionResources", { resources: request.resources.join(", ") })}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="permission-allow-once"
              disabled={value.busy}
              onClick={() => decide(request.id, "once")}
              className="btn btn-primary btn-xs"
            >
              {t("chat.permissionAllowOnce")}
            </button>
            <button
              type="button"
              data-testid="permission-allow-always"
              disabled={value.busy}
              onClick={() => decide(request.id, "always")}
              className="btn btn-xs"
            >
              {t("chat.permissionAllowAlways")}
            </button>
            <button
              type="button"
              data-testid="permission-deny"
              disabled={value.busy}
              onClick={() => decide(request.id, "deny")}
              className="btn btn-ghost btn-xs"
            >
              {t("chat.permissionDeny")}
            </button>
          </div>
          {value.failure ? (
            <p role="alert" className="mt-2 text-xs text-error">
              {t("chat.permissionFailed")}
            </p>
          ) : null}
        </div>
      ))}
      <p className="px-1 text-xs text-muted">{t("chat.permissionHint")}</p>
    </div>
  )
}
