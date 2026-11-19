import type {
  FormAnswer,
  FormAnswerValue,
  FormField,
  FormNumberField,
  FormRequest,
} from "@openchat/contracts"
import { useId, useMemo, useState } from "react"
import { useT } from "../i18n/provider"
import { initialFormAnswers, isFormFieldVisible, type FormsValue } from "./forms"

/**
 * One host form (FR-16) above the composer. Every field type the pinned
 * `Form.Fields` schema exposes is rendered: text (with `format`), select when
 * the host offers options, number/integer, confirm (boolean), multi-choice and
 * the external link step. Native inputs keep it keyboard-operable; a required
 * field blocks the answer and says which value is missing.
 */
export function FormCard({ form, value }: { form: FormRequest; value: FormsValue }) {
  const t = useT()
  const baseID = useId()
  const [answers, setAnswers] = useState<FormAnswer>(() => initialFormAnswers(form))
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set())
  const submitted = value.submitted.has(form.id)
  const expired = value.expired.has(form.id)
  const disabled = value.busy || submitted
  const visible = useMemo(
    () => form.fields.filter((field) => isFormFieldVisible(field, answers)),
    [form.fields, answers],
  )
  const titleID = `${baseID}-title`

  const update = (key: string, next: FormAnswerValue | undefined) => {
    setAnswers((current) => {
      const copy = { ...current }
      if (next === undefined) delete copy[key]
      else copy[key] = next
      return copy
    })
  }

  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault()
    const absent = missingFields(visible, answers)
    setMissing(absent)
    if (absent.size > 0) return
    void value.reply(form.id, collectAnswer(visible, answers))
  }

  return (
    <section
      data-testid="form-card"
      data-form-id={form.id}
      aria-labelledby={titleID}
      className="mb-2 rounded-card border border-subtle bg-surface p-3 text-sm"
    >
      <h2 id={titleID} className="font-semibold">
        {form.title}
      </h2>
      {expired ? (
        <p role="status" className="mt-2 text-xs text-error">
          {t("chat.formExpired")}
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="mt-2 flex flex-col gap-2">
          <p className="text-xs text-muted">{t("chat.formHint")}</p>
          {visible.map((field, index) => {
            const id = `${baseID}-field-${index}`
            const descriptionID = `${baseID}-desc-${index}`
            const fieldMissing = missing.has(field.key)
            return (
              <FormFieldInput
                key={field.key}
                id={id}
                field={field}
                answer={answers[field.key]}
                descriptionID={field.description ? descriptionID : undefined}
                missing={fieldMissing}
                disabled={disabled}
                onChange={(next) => update(field.key, next)}
              />
            )
          })}
          {value.failure ? (
            <p role="alert" className="text-xs text-error">
              {t("chat.formFailed")}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              data-testid="form-submit"
              disabled={disabled}
              className="btn btn-primary btn-xs"
            >
              {value.busy ? t("chat.formSubmitting") : t("chat.formSubmit")}
            </button>
            {submitted ? (
              <p role="status" data-testid="form-submitted" className="text-xs text-muted">
                {t("chat.formSubmitted")}
              </p>
            ) : null}
          </div>
        </form>
      )}
    </section>
  )
}

/**
 * The external step's URL comes from the host or the agent, so it is untrusted.
 * Only an absolute `http:`/`https:` URL may become a live link; anything else
 * stays plain hint text instead of a clickable (or script-capable) target.
 */
export function externalHref(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

/** The single numeric interface covers the host's two numeric tags. */
function isNumericField(field: FormField): field is FormNumberField {
  return field.type === "number" || field.type === "integer"
}

/** Required values the visible fields still need before an answer is sent. */
function missingFields(fields: readonly FormField[], answers: FormAnswer): Set<string> {
  const missing = new Set<string>()
  for (const field of fields) {
    if (field.type === "external") continue
    const answer = answers[field.key]
    if (field.type === "multiselect" && field.minItems !== undefined) {
      if (!Array.isArray(answer) || answer.length < field.minItems) missing.add(field.key)
    }
    if (field.required !== true) continue
    if (answer === undefined) {
      missing.add(field.key)
      continue
    }
    if (typeof answer === "string" && answer.trim() === "") missing.add(field.key)
    if (Array.isArray(answer) && answer.length === 0) missing.add(field.key)
    if (field.type === "boolean" && answer !== true) missing.add(field.key)
  }
  return missing
}

/** Only the visible fields the user actually filled in travel to the host. */
function collectAnswer(fields: readonly FormField[], answers: FormAnswer): FormAnswer {
  const answer: FormAnswer = {}
  for (const field of fields) {
    if (field.type === "external") continue
    const current = answers[field.key]
    if (current === undefined) continue
    if (typeof current === "string") {
      const text = current.trim()
      if (text.length === 0) continue
      answer[field.key] = text
    } else {
      answer[field.key] = current
    }
  }
  return answer
}

function FormFieldInput({
  id,
  field,
  answer,
  descriptionID,
  missing,
  disabled,
  onChange,
}: {
  id: string
  field: FormField
  answer: FormAnswerValue | undefined
  descriptionID?: string
  missing: boolean
  disabled: boolean
  onChange: (next: FormAnswerValue | undefined) => void
}) {
  const t = useT()
  const label = field.title ?? field.key
  const describedBy = descriptionID

  if (field.type === "external") {
    const href = externalHref(field.url)
    return (
      <div data-testid={`form-field-${field.key}`}>
        <p className="text-xs font-medium">{label}</p>
        {field.description ? (
          <p className="text-xs text-muted">{field.description}</p>
        ) : null}
        <p className="text-xs text-muted">{t("chat.formExternalHint")}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs underline"
            data-testid={`form-external-${field.key}`}
          >
            {t("chat.formOpenExternal")}
          </a>
        ) : null}
      </div>
    )
  }

  if (field.type === "boolean") {
    return (
      <div data-testid={`form-field-${field.key}`}>
        <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium">
          <input
            id={id}
            type="checkbox"
            checked={answer === true}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={missing || undefined}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{label}</span>
        </label>
        <FieldNotes id={descriptionID} field={field} missing={missing} />
      </div>
    )
  }

  if (field.type === "multiselect") {
    return (
      <fieldset data-testid={`form-field-${field.key}`} className="flex flex-col gap-1">
        <legend className="text-xs font-medium">
          {label}
          {field.required ? <RequiredMark /> : null}
        </legend>
        {field.options.map((option) => {
          const selected = Array.isArray(answer) ? answer : []
          const optionID = `${id}-${option.value}`
          return (
            <label key={option.value} htmlFor={optionID} className="flex items-center gap-2 text-xs">
              <input
                id={optionID}
                type="checkbox"
                checked={selected.includes(option.value)}
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value)
                  onChange(next)
                }}
              />
              <span>{option.label}</span>
              {option.description ? (
                <span className="text-muted">{option.description}</span>
              ) : null}
            </label>
          )
        })}
        <FieldNotes id={descriptionID} field={field} missing={missing} />
      </fieldset>
    )
  }

  if (isNumericField(field)) {
    return (
      <div data-testid={`form-field-${field.key}`} className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs font-medium">
          {label}
          {field.required ? <RequiredMark /> : null}
        </label>
        <input
          id={id}
          type="number"
          inputMode={field.type === "integer" ? "numeric" : "decimal"}
          step={field.type === "integer" ? 1 : "any"}
          min={field.minimum}
          max={field.maximum}
          value={typeof answer === "number" ? String(answer) : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={missing || undefined}
          onChange={(event) =>
            onChange(event.target.value === "" ? undefined : Number(event.target.value))
          }
          className="w-40 rounded-row border border-subtle bg-surface px-2 py-1 text-sm"
        />
        <FieldNotes id={descriptionID} field={field} missing={missing} />
      </div>
    )
  }

  const text = typeof answer === "string" ? answer : ""
  const inputType =
    field.format === "email"
      ? "email"
      : field.format === "uri"
        ? "url"
        : field.format === "date"
          ? "date"
          : field.format === "date-time"
            ? "datetime-local"
            : "text"
  return (
    <div data-testid={`form-field-${field.key}`} className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
        {field.required ? <RequiredMark /> : null}
      </label>
      {field.options && field.custom !== true ? (
        <select
          id={id}
          value={text}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={missing || undefined}
          onChange={(event) => onChange(event.target.value || undefined)}
          className="rounded-row border border-subtle bg-surface px-2 py-1 text-sm"
        >
          <option value="">{t("chat.formChooseOption")}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            id={id}
            type={inputType}
            list={field.options ? `${id}-options` : undefined}
            value={text}
            disabled={disabled}
            placeholder={field.placeholder}
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            aria-describedby={describedBy}
            aria-invalid={missing || undefined}
            onChange={(event) => onChange(event.target.value || undefined)}
            className="rounded-row border border-subtle bg-surface px-2 py-1 text-sm"
          />
          {field.options ? (
            <datalist id={`${id}-options`}>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </datalist>
          ) : null}
        </>
      )}
      <FieldNotes id={descriptionID} field={field} missing={missing} />
    </div>
  )
}

function RequiredMark() {
  const t = useT()
  return (
    <span className="ms-1 text-error" aria-label={t("chat.formRequiredMark")}>
      *
    </span>
  )
}

function FieldNotes({
  id,
  field,
  missing,
}: {
  id?: string
  field: FormField
  missing: boolean
}) {
  const t = useT()
  return (
    <>
      {field.description && id ? (
        <p id={id} className="text-xs text-muted">
          {field.description}
        </p>
      ) : null}
      {missing ? (
        <p role="alert" className="text-xs text-error">
          {t("chat.formFieldRequired")}
        </p>
      ) : null}
    </>
  )
}
