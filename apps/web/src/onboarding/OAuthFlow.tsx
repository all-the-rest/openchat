import type { ProviderFormAnswer, ProviderMethod, ProviderOAuthAttempt } from "@openchat/contracts"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { api } from "../api/client"
import { useT } from "../i18n/provider"
import { initialValues, ProviderField, type FieldValue } from "./ProviderField"
import { onboardingError, type Notice } from "./errors"

type Phase = "idle" | "pending" | "complete" | "failed" | "expired"

export interface OAuthFlowProps {
  providerID: string
  method: ProviderMethod
  disabled?: boolean
  /** Poll interval; tests shorten it instead of waiting for the default. */
  pollMs?: number
  onConnected(): Promise<void>
}

function answerOf(values: Record<string, FieldValue>): ProviderFormAnswer {
  const answer: ProviderFormAnswer = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) answer[key] = value
  }
  return answer
}

/**
 * OAuth/device method: the host returns a URL (and instructions), the browser
 * polls a stable status. Cancel removes the attempt on the host; a completed
 * attempt re-reads the model catalogue through the parent.
 */
export function OAuthFlow({ providerID, method, disabled, pollMs = 1_500, onConnected }: OAuthFlowProps) {
  const t = useT()
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(method.form))
  const [attempt, setAttempt] = useState<ProviderOAuthAttempt | null>(null)
  const [code, setCode] = useState("")
  const [phase, setPhase] = useState<Phase>("idle")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const blocked = busy || disabled === true

  const finish = useCallback(async () => {
    setPhase("complete")
    await onConnected()
  }, [onConnected])

  useEffect(() => {
    if (!attempt || phase !== "pending") return
    let active = true
    const tick = async () => {
      try {
        const status = await api.providerOAuthStatus(providerID, attempt.id)
        if (!active) return
        if (status.status === "complete") {
          await finish()
          return
        }
        if (status.status === "failed" || status.status === "expired") {
          setPhase(status.status)
          setNotice({ key: status.status === "expired" ? "firstRun.oauth.expired" : "firstRun.oauth.failed" })
        }
      } catch (error) {
        if (!active) return
        setPhase("failed")
        setNotice(onboardingError(error))
      }
    }
    const timer = setInterval(() => void tick(), pollMs)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [attempt, phase, providerID, pollMs, finish])

  const start = async (event: FormEvent) => {
    event.preventDefault()
    if (blocked) return
    setBusy(true)
    setNotice(null)
    try {
      const started = await api.startProviderOAuth(providerID, {
        methodID: method.id,
        answer: answerOf(values),
      })
      setAttempt(started.attempt)
      setPhase("pending")
    } catch (error) {
      setNotice(onboardingError(error))
    } finally {
      setBusy(false)
    }
  }

  const complete = async () => {
    if (!attempt || blocked || (attempt.needsCode && code.trim().length === 0)) return
    setBusy(true)
    setNotice(null)
    try {
      await api.completeProviderOAuth(
        providerID,
        attempt.id,
        attempt.needsCode ? code.trim() : undefined,
      )
      await finish()
    } catch (error) {
      setNotice(onboardingError(error))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!attempt || blocked) return
    setBusy(true)
    try {
      await api.cancelProviderOAuth(providerID, attempt.id)
      setAttempt(null)
      setCode("")
      setPhase("idle")
      setNotice(null)
    } catch (error) {
      setNotice(onboardingError(error))
    } finally {
      setBusy(false)
    }
  }

  if (attempt && phase !== "idle") {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" aria-live="polite" data-testid="oauth-status" className="text-sm">
          {phase === "pending"
            ? t("firstRun.oauth.pending")
            : phase === "complete"
              ? t("firstRun.oauth.done")
              : null}
        </p>
        {attempt.instructions ? <p className="text-sm">{attempt.instructions}</p> : null}
        {attempt.url ? (
          <a
            href={attempt.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="oauth-link"
            className="link link-primary text-sm"
          >
            {t("firstRun.oauth.open")}
          </a>
        ) : null}
        {attempt.code ? (
          <p className="text-sm">
            <code data-testid="oauth-code">{attempt.code}</code>
          </p>
        ) : null}
        {attempt.needsCode ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="oauth-code-input" className="text-sm">
              {t("firstRun.oauth.codeLabel")}
            </label>
            <input
              id="oauth-code-input"
              data-testid="oauth-code-input"
              type="text"
              autoComplete="one-time-code"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby="oauth-code-hint"
              className="input input-sm w-full"
            />
            <p id="oauth-code-hint" className="text-xs text-muted">
              {t("firstRun.oauth.codeHint")}
            </p>
          </div>
        ) : null}
        {notice ? (
          <p role="alert" data-testid="first-run-error" className="text-sm text-error">
            {t(notice.key, notice.vars)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="oauth-complete"
            onClick={() => void complete()}
            disabled={
              blocked ||
              phase !== "pending" ||
              (attempt.needsCode && code.trim().length === 0)
            }
            className="btn btn-primary btn-sm"
          >
            {attempt.needsCode ? t("firstRun.oauth.completeCode") : t("firstRun.oauth.complete")}
          </button>
          <button
            type="button"
            data-testid="oauth-cancel"
            onClick={() => void cancel()}
            disabled={blocked || phase !== "pending"}
            className="btn btn-ghost btn-sm"
          >
            {t("firstRun.oauth.cancel")}
          </button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={(event) => void start(event)} className="flex flex-col gap-3" noValidate>
      <fieldset className="flex flex-col gap-3" disabled={blocked}>
        <legend className="sr-only">{method.label}</legend>
        {method.form.map((field) => (
          <ProviderField
            key={field.key}
            field={field}
            value={values[field.key]}
            invalid={false}
            disabled={blocked}
            onChange={(value) =>
              setValues((current) => {
                const next = { ...current }
                if (value === undefined) delete next[field.key]
                else next[field.key] = value
                return next
              })
            }
          />
        ))}
      </fieldset>
      {notice ? (
        <p role="alert" data-testid="first-run-error" className="text-sm text-error">
          {t(notice.key, notice.vars)}
        </p>
      ) : null}
      <button
        type="submit"
        data-testid="oauth-start"
        disabled={blocked}
        className="btn btn-primary btn-sm self-start"
      >
        {busy ? (
          <span className="loading loading-spinner loading-xs" aria-hidden="true" />
        ) : null}
        {busy ? t("firstRun.oauth.starting") : t("firstRun.oauth.start")}
      </button>
    </form>
  )
}
