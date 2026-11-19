import type { ProviderFormField } from "@openchat/contracts"
import { useT } from "../i18n/provider"

export type FieldValue = string | number | boolean | string[]

export interface ProviderFieldProps {
  field: ProviderFormField
  value: FieldValue | undefined
  invalid: boolean
  disabled: boolean
  onChange(value: FieldValue | undefined): void
}

function labelOf(field: ProviderFormField): string {
  // The host owns the human title; the key is the stable fallback.
  return field.title ?? field.key
}

/**
 * One declared provider field. The host's `secret` field is always rendered by
 * the dedicated key input, never here, so this component only carries
 * non-secret values. Native form controls give the browser's validation,
 * focus handling and screen-reader semantics for free.
 */
export function ProviderField({ field, value, invalid, disabled, onChange }: ProviderFieldProps) {
  const t = useT()
  const id = `provider-field-${field.key}`
  const describedBy = field.description ? `${id}-description` : undefined
  const common = {
    id,
    name: field.key,
    disabled,
    required: field.required,
    "aria-required": field.required || undefined,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    "data-testid": `provider-field-${field.key}`,
  } as const

  if (field.type === "boolean") {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            className="checkbox checkbox-sm"
          />
          <span>{labelOf(field)}</span>
        </label>
        {field.description ? (
          <p id={`${id}-description`} className="text-xs text-muted">
            {field.description}
          </p>
        ) : null}
      </div>
    )
  }

  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value : []
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm">
          {labelOf(field)}
        </label>
        <select
          {...common}
          multiple
          size={Math.min(4, Math.max(2, field.options?.length ?? 2))}
          value={selected}
          onChange={(event) =>
            onChange(Array.from(event.target.selectedOptions, (option) => option.value))
          }
          className="select select-sm w-full"
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.description ? (
          <p id={`${id}-description`} className="text-xs text-muted">
            {field.description}
          </p>
        ) : null}
      </div>
    )
  }

  if (field.type === "string" && field.options && field.options.length > 0) {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm">
          {labelOf(field)}
        </label>
        <select
          {...common}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            const next = event.target.value
            // An optional field left on the placeholder is absent, not empty.
            onChange(next === "" && !field.required ? undefined : next)
          }}
          className="select select-sm w-full"
        >
          {field.required ? null : <option value="">{t("firstRun.fieldUnset")}</option>}
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.description ? (
          <p id={`${id}-description`} className="text-xs text-muted">
            {field.description}
          </p>
        ) : null}
      </div>
    )
  }

  const numeric = field.type === "number" || field.type === "integer"
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm">
        {labelOf(field)}
      </label>
      <input
        {...common}
        type={numeric ? "number" : "text"}
        inputMode={numeric ? "numeric" : undefined}
        step={field.type === "integer" ? 1 : undefined}
        min={numeric ? field.minimum : undefined}
        max={numeric ? field.maximum : undefined}
        minLength={field.type === "string" ? field.minLength : undefined}
        maxLength={field.type === "string" ? field.maxLength : undefined}
        pattern={field.type === "string" ? field.pattern : undefined}
        placeholder={field.type === "string" ? field.placeholder : undefined}
        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
        onChange={(event) => {
          const raw = event.target.value
          if (!numeric) {
            // An optional field cleared by the owner is absent, not empty.
            onChange(raw === "" && !field.required ? undefined : raw)
            return
          }
          onChange(raw === "" ? undefined : Number(raw))
        }}
        className="input input-sm w-full"
      />
      {field.description ? (
        <p id={`${id}-description`} className="text-xs text-muted">
          {field.description}
        </p>
      ) : null}
    </div>
  )
}

/** Non-secret defaults the host declared, ready to seed the form state. */
export function initialValues(form: readonly ProviderFormField[]): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const field of form) {
    if (field.secret || field.defaultValue === undefined) continue
    values[field.key] = field.defaultValue
  }
  return values
}
