import type { ProviderFormAnswer, ProviderMethod } from "@openchat/contracts"
import { useState, type FormEvent } from "react"
import { api } from "../api/client"
import { useT } from "../i18n/provider"
import { initialValues, ProviderField, type FieldValue } from "./ProviderField"
import { invalidFieldOf, onboardingError, type Notice } from "./errors"

export interface ProviderKeyFormProps {
  providerID: string
  method: ProviderMethod
  /** Renders a busy state while the parent refreshes the catalogue. */
  disabled?: boolean
  /** Called after the host accepted the credential. */
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
 * API-key method: the secret is one dedicated password field, never part of
 * the answer map, and it is cleared when the request settles. A failed
 * connection keeps every non-secret field so the owner only re-enters the key.
 */
export function ProviderKeyForm({ providerID, method, disabled, onConnected }: ProviderKeyFormProps) {
  const t = useT()
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(method.form))
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [invalidField, setInvalidField] = useState<string | null>(null)
  const secret = method.form.find((field) => field.secret)
  const fields = method.form.filter((field) => !field.secret)
  const blocked = busy || disabled === true

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (blocked || key.length === 0) return
    setBusy(true)
    setNotice(null)
    setInvalidField(null)
    try {
      await api.connectProviderKey(providerID, {
        methodID: method.id,
        key,
        answer: answerOf(values),
      })
      await onConnected()
    } catch (error) {
      setNotice(onboardingError(error))
      setInvalidField(invalidFieldOf(error))
    } finally {
      // The value is gone from client state once the request settles, on
      // success and on failure alike; only the non-secret fields survive.
      setKey("")
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" noValidate>
      <fieldset className="flex flex-col gap-3" disabled={blocked}>
        <legend className="sr-only">{method.label}</legend>
        <div className="flex flex-col gap-1">
          <label htmlFor="provider-key" className="text-sm">
            {secret?.title ?? t("firstRun.keyLabel")}
          </label>
          <input
            id="provider-key"
            name="key"
            data-testid="provider-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            minLength={secret?.minLength}
            maxLength={secret?.maxLength}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-invalid={invalidField === "key" || undefined}
            aria-describedby="provider-key-hint"
            className="input input-sm w-full"
          />
          <p id="provider-key-hint" className="text-xs text-muted">
            {t("firstRun.keyHint")}
          </p>
        </div>

        {fields.map((field) => (
          <ProviderField
            key={field.key}
            field={field}
            value={values[field.key]}
            invalid={invalidField === field.key}
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
        data-testid="provider-connect-submit"
        disabled={blocked || key.length === 0}
        className="btn btn-primary btn-sm self-start"
      >
        {busy ? (
          <span className="loading loading-spinner loading-xs" aria-hidden="true" />
        ) : null}
        {busy ? t("firstRun.connecting") : t("firstRun.connect")}
      </button>
    </form>
  )
}
