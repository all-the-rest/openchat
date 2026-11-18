import type { AppServer, AppStatus } from "@openchat/contracts"
import { useT } from "../i18n/provider"
import { STATUS_LABEL } from "../search/sources"
import type { AppAction } from "./types"

/** Which action the host API offers for a status; `disabled` has none. */
export function actionFor(status: AppStatus): AppAction | null {
  if (status === "connected" || status === "pending") return "disconnect"
  if (status === "failed" || status === "needs_auth") return "connect"
  return null
}

function label(server: AppServer): string {
  return server.title ?? server.name
}

function ServerRow({
  server,
  busy,
  onAction,
}: {
  server: AppServer
  busy: boolean
  onAction(server: AppServer, action: AppAction): void
}) {
  const t = useT()
  const statusKey = STATUS_LABEL[server.status]
  const action = actionFor(server.status)
  const failed = server.status === "failed" || server.status === "needs_auth"

  return (
    <li
      data-testid="apps-server"
      className="flex flex-col gap-1 rounded-row border border-subtle bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label(server)}</span>
        <span data-testid="apps-server-status" className="badge badge-sm badge-outline">
          {statusKey ? t(statusKey) : server.status}
        </span>
        {action ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(server, action)}
            aria-label={t(
              action === "connect" ? "apps.connectServer" : "apps.disconnectServer",
              { server: label(server) },
            )}
            className="btn btn-sm"
          >
            {t(action === "connect" ? "apps.connect" : "apps.disconnect")}
          </button>
        ) : null}
      </div>
      {failed && server.error ? (
        <p className="text-xs text-muted">{server.error}</p>
      ) : null}
      {server.status === "disabled" ? (
        <p className="text-xs text-muted">{t("apps.disabledNote")}</p>
      ) : null}
    </li>
  )
}

export function ServerList({
  servers,
  busyName,
  onAction,
}: {
  servers: AppServer[]
  /** The server whose request runs; every row's button waits for it. */
  busyName: string | null
  onAction(server: AppServer, action: AppAction): void
}) {
  const t = useT()

  return (
    <section aria-labelledby="apps-servers-heading" className="flex flex-col gap-2">
      <h2 id="apps-servers-heading" className="text-sm font-semibold">
        {t("apps.servers")}
      </h2>
      {servers.length === 0 ? (
        <p className="text-sm text-muted">{t("apps.noServers")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              busy={busyName !== null}
              onAction={onAction}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
