import { useCallback, useEffect, useRef, useState } from "react"
import type { AppServer, AppsResponse } from "@openchat/contracts"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import { useT } from "../i18n/provider"
import { ServerList } from "./ServerList"
import { SkillList } from "./SkillList"
import { appActionError, type AppNotice } from "./errors"
import type { AppAction } from "./types"

type LoadStatus = "loading" | "ready" | "error"

/**
 * `/apps` — the workspace's MCP servers and skills.
 *
 * The host owns every status here, so an action never mutates the row: it
 * posts the connect/disconnect and re-reads `/api/apps`, then renders whatever
 * the host reports next. The pinned host API cannot list tools, so there is no
 * tools section at all.
 */
export function AppsPage() {
  const t = useT()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [data, setData] = useState<AppsResponse | null>(null)
  const [busy, setBusy] = useState<{ name: string; action: AppAction } | null>(null)
  const [banner, setBanner] = useState<AppNotice | null>(null)
  const [notice, setNotice] = useState<AppNotice | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setStatus("loading")
    try {
      const response = await api.apps()
      if (!alive.current) return
      setData(response)
      setStatus("ready")
    } catch {
      if (!alive.current) return
      if (silent) {
        // The action succeeded but the outcome is unknown: the banner is the
        // whole story, so a success notice from before the read must go.
        setNotice(null)
        setBanner({ key: "apps.error.host" })
      } else {
        setStatus("error")
      }
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const runAction = async (server: AppServer, action: AppAction) => {
    if (busy) return
    setBusy({ name: server.name, action })
    setBanner(null)
    setNotice(null)
    try {
      if (action === "connect") await api.connectApp(server.name)
      else await api.disconnectApp(server.name)
      if (!alive.current) return
      setNotice({
        key: action === "connect" ? "apps.action.connectDone" : "apps.action.disconnectDone",
        vars: { server: server.title ?? server.name },
      })
      // 204 carries no status; only the host's next read tells the truth.
      await load(true)
    } catch (error) {
      if (!alive.current) return
      setBanner(appActionError(error))
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  const retry = () => {
    setBanner(null)
    void load(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{t("apps.title")}</h1>
          <p className="text-sm text-muted">{t("apps.description")}</p>
        </header>

        {banner ? (
          <ErrorBanner message={t(banner.key, banner.vars)} onDismiss={() => setBanner(null)} />
        ) : null}

        <p
          role="status"
          aria-live="polite"
          data-testid="apps-notice"
          className="min-h-5 text-sm text-muted"
        >
          {notice ? t(notice.key, notice.vars) : null}
        </p>

        {status === "loading" ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="apps-loading"
            className="flex items-center gap-2 text-sm text-muted"
          >
            <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            {t("apps.loading")}
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorBanner message={t("apps.loadFailed")} />
            <button type="button" onClick={retry} className="btn btn-sm">
              {t("apps.retry")}
            </button>
          </div>
        ) : data && !data.available ? (
          <p className="text-sm text-muted">{t("apps.unavailable")}</p>
        ) : data ? (
          <>
            <ServerList
              servers={data.servers}
              busyName={busy?.name ?? null}
              onAction={(server, action) => void runAction(server, action)}
            />
            <SkillList skills={data.skills} />
          </>
        ) : null}
      </div>
    </div>
  )
}
