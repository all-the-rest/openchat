import type { OpenCodeClient } from "@opencode/client"
import type {
  FormAnswer,
  FormField,
  FormFieldCondition,
  FormMultiselectField,
  FormNumberField,
  FormRequest,
  FormTextField,
} from "@openchat/contracts"
import { BackendError } from "./errors"

type HostForm = Awaited<ReturnType<OpenCodeClient["session"]["form"]["list"]>>[number]
type HostField = HostForm["fields"][number]
type HostDetail = Awaited<ReturnType<OpenCodeClient["session"]["form"]["get"]>>

/** Keys every field variant shares; the card reads them before the type. */
interface FormFieldCommon {
  key: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  when?: FormFieldCondition[]
}

/**
 * The host's numeric bounds are a JSON-safe union that also carries the
 * strings `"Infinity"`, `"-Infinity"` and `"NaN"`. An HTML input cannot carry
 * those, so only a finite number becomes an attribute; the rest is dropped
 * rather than invented.
 */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function condition(value: unknown): FormFieldCondition[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list: FormFieldCondition[] = []
  for (const entry of value as Array<Record<string, unknown>>) {
    if (typeof entry.key !== "string") continue
    if (entry.op !== "eq" && entry.op !== "neq") continue
    const operand = entry.value
    if (typeof operand === "string" || typeof operand === "number" ||
      typeof operand === "boolean") {
      list.push({ key: entry.key, op: entry.op, value: operand })
    }
  }
  return list.length > 0 ? list : undefined
}

function common(field: HostField): FormFieldCommon {
  const mapped: FormFieldCommon = { key: field.key }
  if (typeof field.title === "string") mapped.title = field.title
  if (typeof field.description === "string") mapped.description = field.description
  if ("required" in field && field.required === true) mapped.required = true
  if ("hidden" in field && field.hidden === true) mapped.hidden = true
  if ("when" in field) {
    const when = condition(field.when)
    if (when) mapped.when = when
  }
  return mapped
}

function option(entry: {
  value: string
  label: string
  description?: string
}): { value: string; label: string; description?: string } {
  const mapped: { value: string; label: string; description?: string } = {
    value: entry.value,
    label: entry.label,
  }
  if (typeof entry.description === "string") mapped.description = entry.description
  return mapped
}

/** Maps one host field onto the contract shape the card renders. */
export function normalizeFormField(field: HostField): FormField {
  const shared = common(field)
  switch (field.type) {
    case "string": {
      const mapped: FormTextField = { ...shared, type: "string" }
      if (typeof field.format === "string") mapped.format = field.format
      const minLength = finite(field.minLength)
      const maxLength = finite(field.maxLength)
      if (minLength !== undefined) mapped.minLength = minLength
      if (maxLength !== undefined) mapped.maxLength = maxLength
      if (typeof field.pattern === "string") mapped.pattern = field.pattern
      if (typeof field.placeholder === "string") mapped.placeholder = field.placeholder
      if (typeof field.default === "string") mapped.default = field.default
      if (Array.isArray(field.options)) mapped.options = field.options.map(option)
      if (field.custom === true) mapped.custom = true
      return mapped
    }
    case "number":
    case "integer": {
      const mapped: FormNumberField = { ...shared, type: field.type }
      const minimum = finite(field.minimum)
      const maximum = finite(field.maximum)
      const fallback = finite(field.default)
      if (minimum !== undefined) mapped.minimum = minimum
      if (maximum !== undefined) mapped.maximum = maximum
      if (fallback !== undefined) mapped.default = fallback
      return mapped
    }
    case "boolean":
      return field.default === true
        ? { ...shared, type: "boolean", default: true }
        : { ...shared, type: "boolean" }
    case "multiselect": {
      const mapped: FormMultiselectField = {
        ...shared,
        type: "multiselect",
        options: field.options.map(option),
      }
      const minItems = finite(field.minItems)
      const maxItems = finite(field.maxItems)
      if (minItems !== undefined) mapped.minItems = minItems
      if (maxItems !== undefined) mapped.maxItems = maxItems
      if (field.custom === true) mapped.custom = true
      if (Array.isArray(field.default)) mapped.default = [...field.default]
      return mapped
    }
    case "external":
      return { ...shared, type: "external", url: field.url }
  }
}

export function normalizeForm(form: HostForm): FormRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    title: form.title,
    fields: form.fields.map(normalizeFormField),
  }
}

/** One session's open forms. */
export async function listHostForms(
  client: OpenCodeClient,
  sessionID: string,
): Promise<FormRequest[]> {
  const forms = await client.session.form.list({ sessionID })
  return forms.map(normalizeForm)
}

/**
 * `form.reply` reports every failure generically, so a pre-read separates an
 * unknown id (404) and a form that already left the open state (409) from a
 * transient host failure.
 */
export async function replyHostForm(
  client: OpenCodeClient,
  sessionID: string,
  formID: string,
  answer: FormAnswer,
): Promise<void> {
  let detail: HostDetail
  try {
    detail = await client.session.form.get({ sessionID, formID })
  } catch {
    throw new BackendError("not_found", `Unknown form: ${formID}`)
  }
  if (detail.state.status === "answered") {
    throw new BackendError("conflict", `Form ${formID} has already been answered`)
  }
  if (detail.state.status === "cancelled") {
    throw new BackendError("conflict", `Form ${formID} has been cancelled`)
  }
  await client.session.form.reply({ sessionID, formID, answer })
}
