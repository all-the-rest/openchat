import { useT } from "../i18n/provider"
import type { PermissionValue } from "./permissions"

/**
 * Approval above the composer. Real buttons keep every action in the tab
 * order, and the composer is disabled while a request is outstanding so a
 * prompt cannot be sent before the user decides.
 */
export function PermissionCard({ value }: { value: PermissionValue }) {
  const t = useT()
  if (value.requests.length === 0) return null

  return (
    <div
      role="group"
      aria-label={t("chat.permissionTitle")}
      data-testid="permission-card"
      className="mb-2 flex flex-col gap-2"
    >
      {value.requests.map((request) => (
        <div
          key={request.id}
          data-testid="permission-request"
          className="rounded-card border border-subtle bg-surface p-3 text-sm"
        >
          <p className="font-semibold">{t("chat.permissionTitle")}</p>
          <p className="mt-1">{t("chat.permissionTool", { tool: request.tool })}</p>
          <p className="break-words">{request.action}</p>
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
              onClick={() => void value.reply(request.id, "once")}
              className="btn btn-primary btn-xs"
            >
              {t("chat.permissionAllowOnce")}
            </button>
            <button
              type="button"
              data-testid="permission-allow-always"
              disabled={value.busy}
              onClick={() => void value.reply(request.id, "always")}
              className="btn btn-xs"
            >
              {t("chat.permissionAllowAlways")}
            </button>
            <button
              type="button"
              data-testid="permission-deny"
              disabled={value.busy}
              onClick={() => void value.reply(request.id, "deny")}
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
