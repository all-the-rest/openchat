import type { ProviderInfo, ProviderMethod } from "@openchat/contracts"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../api/client"
import { useCompletion } from "../chat/completion"
import { useSurfaceOrNull } from "../code/SurfaceProvider"
import { useT } from "../i18n/provider"
import { OAuthFlow } from "./OAuthFlow"
import { ProviderKeyForm } from "./ProviderKeyForm"
import { onboardingError, type Notice } from "./errors"

interface Selection {
  providerID: string
  methodID: string
}

function firstSelection(providers: ProviderInfo[]): Selection | null {
  const provider = providers.find((entry) => entry.methods.length > 0)
  const method = provider?.methods[0]
  return provider && method ? { providerID: provider.id, methodID: method.id } : null
}

function methodOf(providers: ProviderInfo[], selection: Selection | null): ProviderMethod | null {
  if (!selection) return null
  const provider = providers.find((entry) => entry.id === selection.providerID)
  return provider?.methods.find((entry) => entry.id === selection.methodID) ?? null
}

function hostOnly(method: ProviderMethod): boolean {
  return method.type === "command" || method.type === "external" || method.type === "env"
}

/**
 * First-run card: catalogue, one method, the declared form, a verify step and
 * the host-side escape hatch. It renders only while the model catalogue is
 * empty; the gate unmounts it as soon as a connection yields a model.
 */
export function FirstRunCard() {
  const t = useT()
  const completion = useCompletion()
  const surface = useSurfaceOrNull()
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [verifying, setVerifying] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const catalogue = await api.providers()
      setProviders(catalogue)
      setSelection((current) => {
        if (current && methodOf(catalogue, current)) return current
        return firstSelection(catalogue)
      })
    } catch {
      setFailed(true)
      setProviders([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refreshAfterConnect = useCallback(async () => {
    setNotice(null)
    try {
      const models = await completion.refreshModels()
      await surface?.refresh()
      if (models.length === 0) {
        setNotice({ key: "firstRun.noModelYet" })
      } else {
        setNotice({ key: "firstRun.connected" })
      }
    } catch (error) {
      setNotice(onboardingError(error))
    }
    // Re-read the catalogue so the connection badge reflects the host.
    try {
      setProviders(await api.providers())
    } catch {
      // The model outcome above is the actionable state; the badge can wait.
    }
  }, [completion, surface])

  const verify = async () => {
    setVerifying(true)
    try {
      await refreshAfterConnect()
    } finally {
      setVerifying(false)
    }
  }

  const provider = useMemo(
    () => providers?.find((entry) => entry.id === selection?.providerID) ?? null,
    [providers, selection],
  )
  const method = useMemo(() => methodOf(providers ?? [], selection), [providers, selection])

  return (
    <section
      aria-labelledby="first-run-title"
      data-testid="first-run-card"
      className="rounded-card border border-subtle bg-surface p-5"
    >
      <h2 id="first-run-title" className="text-lg font-semibold">
        {t("firstRun.title")}
      </h2>
      <p className="mt-1 text-sm text-secondary">{t("firstRun.description")}</p>

      {providers === null ? (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted">
          <span className="loading loading-spinner loading-xs" aria-hidden="true" />
          {t("firstRun.loading")}
        </p>
      ) : failed ? (
        <div className="mt-4 flex flex-col gap-2">
          <p role="alert" className="text-sm text-error">
            {t("firstRun.loadFailed")}
          </p>
          <button type="button" onClick={() => void load()} className="btn btn-sm self-start">
            {t("firstRun.retry")}
          </button>
        </div>
      ) : providers.length === 0 || providers.every((entry) => entry.methods.length === 0) ? (
        <p role="status" className="mt-4 text-sm text-muted">
          {t("firstRun.noProviders")}
        </p>
      ) : (
        <>
          <p className="mt-4 text-xs font-medium text-muted">{t("firstRun.stepProvider")}</p>
          <fieldset className="mt-2 flex flex-col gap-2">
            <legend className="sr-only">{t("firstRun.methodLabel")}</legend>
            {providers.map((entry) => (
              <div key={entry.id} className="flex flex-col gap-1">
                <p className="text-sm font-medium">
                  {entry.name}
                  {entry.connected ? (
                    <span className="ms-2 text-xs text-success">{t("firstRun.connectedBadge")}</span>
                  ) : null}
                </p>
                {entry.methods.map((option) => (
                  <label
                    key={option.id}
                    className="flex min-h-9 items-center gap-2 rounded-composer px-2 py-1 text-sm hover:bg-app"
                  >
                    <input
                      type="radio"
                      name="provider-method"
                      value={`${entry.id}::${option.id}`}
                      checked={
                        selection?.providerID === entry.id && selection.methodID === option.id
                      }
                      onChange={() => setSelection({ providerID: entry.id, methodID: option.id })}
                      data-testid={`provider-method-${entry.id}-${option.id}`}
                      className="radio radio-sm"
                    />
                    <span>{option.label}</span>
                    {hostOnly(option) ? (
                      <span className="text-xs text-muted">{t("firstRun.hostOnlyBadge")}</span>
                    ) : null}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>

          {provider && method ? (
            <div className="mt-4 border-t border-subtle pt-4">
              <p className="mb-2 text-xs font-medium text-muted">{t("firstRun.stepDetails")}</p>
              {method.type === "key" ? (
                <ProviderKeyForm
                  key={`${provider.id}:${method.id}`}
                  providerID={provider.id}
                  method={method}
                  disabled={verifying}
                  onConnected={refreshAfterConnect}
                />
              ) : method.type === "oauth" ? (
                <OAuthFlow
                  key={`${provider.id}:${method.id}`}
                  providerID={provider.id}
                  method={method}
                  disabled={verifying}
                  onConnected={refreshAfterConnect}
                />
              ) : (
                <p className="text-sm text-secondary">{t("firstRun.hostOnly")}</p>
              )}
            </div>
          ) : null}
        </>
      )}

      {notice ? (
        <p role="status" data-testid="first-run-notice" className="mt-3 text-sm text-secondary">
          {t(notice.key, notice.vars)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-subtle pt-4">
        <button
          type="button"
          data-testid="first-run-verify"
          onClick={() => void verify()}
          disabled={verifying}
          className="btn btn-sm"
        >
          {verifying ? (
            <span className="loading loading-spinner loading-xs" aria-hidden="true" />
          ) : null}
          {verifying ? t("firstRun.verifying") : t("firstRun.verify")}
        </button>
        <p className="text-xs text-muted">{t("firstRun.verifyHint")}</p>
      </div>

      <p data-testid="first-run-host-hint" className="mt-3 text-xs text-muted">
        {t("firstRun.hostHint")}
      </p>
    </section>
  )
}
