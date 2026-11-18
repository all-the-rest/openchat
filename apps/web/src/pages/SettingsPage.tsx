import type { InfoResponse, ModelInfo } from "@openchat/contracts"
import { useEffect, useState } from "react"
import { api } from "../api/client"
import { AgentSelect, ModelSelect } from "../chat/CompletionPicker"
import { LocaleSelect, ThemeToggle } from "../components/controls"
import { useT } from "../i18n/provider"

const ROW = "flex items-center justify-between gap-4 border-b border-subtle py-2 text-sm"
const HEADING = "text-sm font-semibold text-secondary"

/** Read-only status of the host behind the BFF; never a live control. */
function ServerStatus({ info }: { info: InfoResponse | null }) {
  const t = useT()
  if (info === null) {
    return (
      <section aria-label={t("settings.serverStatus")} data-testid="server-status">
        <h2 className={HEADING}>{t("settings.serverStatus")}</h2>
        <p className="mt-2 text-sm text-error">{t("settings.loadFailed")}</p>
      </section>
    )
  }
  const availability = (enabled: boolean) =>
    t(enabled ? "settings.available" : "settings.unavailable")

  return (
    <section aria-label={t("settings.serverStatus")} data-testid="server-status">
      <h2 className={HEADING}>{t("settings.serverStatus")}</h2>
      <dl className="mt-2">
        <div className={ROW}>
          <dt>{t("settings.version")}</dt>
          <dd data-testid="status-version">{info.server?.version ?? t("settings.unavailable")}</dd>
        </div>
        <div className={ROW}>
          <dt>{t("settings.hostReachable")}</dt>
          <dd data-testid="status-host">
            {t(info.host.reachable ? "settings.hostReachable" : "settings.hostUnreachable")}
          </dd>
        </div>
        <div className={ROW}>
          <dt>{t("settings.dictation")}</dt>
          <dd data-testid="status-dictation">{availability(info.dictation.enabled)}</dd>
        </div>
        <div className={ROW}>
          <dt>{t("settings.documents")}</dt>
          <dd data-testid="status-documents">{availability(info.artifacts.available)}</dd>
        </div>
      </dl>
    </section>
  )
}

/** Language, browser-wide chat defaults and host status, inside the app shell. */
export function SettingsPage() {
  const t = useT()
  const [info, setInfo] = useState<InfoResponse | null>(null)
  // `undefined` while loading, `"error"` when the read failed, `null` when the
  // host reports no default.
  const [hostDefault, setHostDefault] = useState<ModelInfo | null | "error" | undefined>(undefined)

  useEffect(() => {
    let active = true
    void api.info().then(
      (value) => {
        if (active) setInfo(value)
      },
      () => {
        if (active) setInfo(null)
      },
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void api.hostDefaultModel().then(
      (value) => {
        if (active) setHostDefault(value.model)
      },
      () => {
        if (active) setHostDefault("error")
      },
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="mx-auto w-full max-w-[768px] px-4 py-6">
      <h1 className="text-xl font-semibold">{t("settings.title")}</h1>
      <div className="mt-6 flex flex-col gap-8">
        <section aria-label={t("language.label")}>
          <h2 className={HEADING}>{t("language.label")}</h2>
          <div className="mt-2 flex items-center gap-2">
            <LocaleSelect />
            <ThemeToggle />
          </div>
        </section>

        <section aria-label={t("settings.defaults")}>
          <h2 className={HEADING}>{t("settings.defaults")}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <span className="text-sm">{t("chat.modelLabel")}</span>
            <ModelSelect />
            <span className="text-sm">{t("chat.agentLabel")}</span>
            <AgentSelect />
          </div>
        </section>

        <ServerStatus info={info} />

        <section aria-label={t("settings.hostDefault")} data-testid="host-default">
          <h2 className={HEADING}>{t("settings.hostDefault")}</h2>
          <p data-testid="host-default-model" className="mt-2 text-sm">
            {hostDefault === undefined
              ? t("settings.loading")
              : hostDefault === "error"
                ? t("settings.hostDefaultUnavailable")
                : hostDefault === null
                  ? t("settings.hostDefaultUnset")
                  : hostDefault.name}
          </p>
          <p className="mt-1 text-xs text-muted">{t("settings.hostDefaultHint")}</p>
        </section>
      </div>
    </div>
  )
}
