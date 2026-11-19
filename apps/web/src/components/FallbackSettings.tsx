import type { FallbackStatusResponse } from "@openchat/contracts"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api/client"
import { useT } from "../i18n/provider"

const HEADING = "text-sm font-semibold text-secondary"
const ROW = "flex items-center justify-between gap-4 border-b border-subtle py-2 text-sm"

type LoadStatus = "loading" | "ready" | "error"

/**
 * Read-only fallback settings: the chain the prompt route enforces, the
 * paid-turn cap and today's ledger counters. Nothing here is a control; the
 * values come from the server's resolved policy, never from a local guess.
 */
export function FallbackSettings() {
  const t = useT()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [fallback, setFallback] = useState<FallbackStatusResponse | null>(null)

  const load = useCallback(() => {
    setStatus("loading")
    return api.fallback().then(
      (value) => {
        setFallback(value)
        setStatus("ready")
      },
      () => setStatus("error"),
    )
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section aria-label={t("settings.fallback")} data-testid="fallback-settings">
      <h2 className={HEADING}>{t("settings.fallback")}</h2>
      {status === "loading" ? (
        <div
          data-testid="fallback-loading"
          className="mt-2 flex items-center gap-2 text-sm text-muted"
        >
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          {t("settings.loading")}
        </div>
      ) : status === "error" || fallback === null ? (
        <div data-testid="fallback-error" role="alert" className="mt-2 text-sm text-error">
          <p>{t("settings.fallbackLoadFailed")}</p>
          <button
            type="button"
            data-testid="fallback-retry"
            onClick={() => void load()}
            className="btn btn-outline btn-sm mt-2"
          >
            {t("settings.fallbackRetry")}
          </button>
        </div>
      ) : fallback.invalid ? (
        <div data-testid="fallback-invalid" role="alert" className="mt-2 text-sm text-warning">
          <p>{t("settings.fallbackInvalid")}</p>
        </div>
      ) : !fallback.configured ? (
        <p data-testid="fallback-unconfigured" className="mt-2 text-sm text-muted">
          {t("settings.fallbackUnconfigured")}
        </p>
      ) : (
        <>
          <ol data-testid="fallback-chain" className="mt-2 list-decimal ps-5">
            {fallback.chain.map((entry) => (
              <li
                key={`${entry.providerID}/${entry.modelID}/${entry.variant ?? ""}`}
                data-testid="fallback-entry"
                className={ROW}
              >
                <span className="font-mono text-xs">
                  {entry.providerID}/{entry.modelID}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {entry.variant === undefined ? null : (
                    <span>{t("settings.fallbackVariant", { variant: entry.variant })}</span>
                  )}
                  {entry.isFree === true ? (
                    <span className="badge badge-sm">{t("settings.fallbackFree")}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          <dl className="mt-2">
            <div className={ROW}>
              <dt>{t("settings.fallbackPaidCap")}</dt>
              <dd data-testid="fallback-cap">
                {fallback.paidDailyCap === 0
                  ? t("settings.fallbackCapOff")
                  : t("settings.fallbackCapValue", { cap: fallback.paidDailyCap })}
              </dd>
            </div>
            <div className={ROW}>
              <dt>{t("settings.fallbackPaidTurnsToday")}</dt>
              <dd data-testid="fallback-paid-today">{fallback.paidTurnsToday}</dd>
            </div>
            <div className={ROW}>
              <dt>{t("settings.fallbackTurnsToday")}</dt>
              <dd data-testid="fallback-turns-today">{fallback.turnsToday}</dd>
            </div>
          </dl>
          <p className="mt-1 text-xs text-muted">{t("settings.fallbackReadOnly")}</p>
        </>
      )}
    </section>
  )
}
