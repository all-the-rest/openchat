import type { ProviderFormAnswer, ProviderFormField } from "@openchat/contracts"

/**
 * Validates a provider form against the rules the host declared. The result
 * names a field and a stable reason; the route turns that into a fixed message
 * and never forwards host text. Unknown answer keys are rejected, which also
 * keeps a secret that a buggy client repeated in `answer` away from the host.
 */
export type FormProblem =
  | { field: string; reason: "required" | "type" | "range" | "pattern" | "format" | "option" }
  | { field: string; reason: "unknown" }

export type FormResult =
  | { ok: true; value: ProviderFormAnswer }
  | { ok: false; problem: FormProblem }

function isMissing(value: unknown): boolean {
  return value === undefined || value === null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validString(field: ProviderFormField, value: string): FormProblem | null {
  if (field.required && value.trim().length === 0) {
    return { field: field.key, reason: "required" }
  }
  if (field.minLength !== undefined && value.length < field.minLength) {
    return { field: field.key, reason: "range" }
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return { field: field.key, reason: "range" }
  }
  if (field.options && field.options.length > 0) {
    if (!field.options.some((option) => option.value === value)) {
      return { field: field.key, reason: "option" }
    }
  }
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(value)) {
        return { field: field.key, reason: "pattern" }
      }
    } catch {
      // A host-owned pattern that does not compile is not a user error.
    }
  }
  if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { field: field.key, reason: "format" }
  }
  if (field.format === "uri") {
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { field: field.key, reason: "format" }
      }
    } catch {
      return { field: field.key, reason: "format" }
    }
  }
  if (field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { field: field.key, reason: "format" }
  }
  if (field.format === "date-time" && Number.isNaN(Date.parse(value))) {
    return { field: field.key, reason: "format" }
  }
  return null
}

function validValue(field: ProviderFormField, value: unknown): FormProblem | null {
  if (isMissing(value)) {
    return field.required ? { field: field.key, reason: "required" } : null
  }
  if (field.type === "string") {
    return typeof value === "string" ? validString(field, value) : { field: field.key, reason: "type" }
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { field: field.key, reason: "type" }
    }
    if (field.type === "integer" && !Number.isInteger(value)) {
      return { field: field.key, reason: "type" }
    }
    if (field.minimum !== undefined && value < field.minimum) {
      return { field: field.key, reason: "range" }
    }
    if (field.maximum !== undefined && value > field.maximum) {
      return { field: field.key, reason: "range" }
    }
    return null
  }
  if (field.type === "boolean") {
    return typeof value === "boolean" ? null : { field: field.key, reason: "type" }
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { field: field.key, reason: "type" }
  }
  if (field.minItems !== undefined && value.length < field.minItems) {
    return { field: field.key, reason: "range" }
  }
  if (field.maxItems !== undefined && value.length > field.maxItems) {
    return { field: field.key, reason: "range" }
  }
  if (field.options && field.options.length > 0) {
    const allowed = new Set(field.options.map((option) => option.value))
    if (value.some((entry) => !allowed.has(entry))) {
      return { field: field.key, reason: "option" }
    }
  }
  return null
}

/**
 * The secret field is validated from `key`, every other declared field from
 * `answer`. A key method without a declared secret still requires `key`.
 */
export function validateKeyForm(
  form: readonly ProviderFormField[],
  key: string,
  answer: ProviderFormAnswer | undefined,
): FormResult {
  const secret = form.find((field) => field.secret)
  const problem = secret ? validValue(secret, key) : null
  if (problem) return { ok: false, problem }
  return validateAnswer(form, answer, secret?.key)
}

/** OAuth and external forms have no secret field; every field lives in `answer`. */
export function validateAnswerForm(
  form: readonly ProviderFormField[],
  answer: ProviderFormAnswer | undefined,
): FormResult {
  return validateAnswer(form, answer, undefined)
}

function validateAnswer(
  form: readonly ProviderFormField[],
  answer: ProviderFormAnswer | undefined,
  secretKey: string | undefined,
): FormResult {
  const input = isPlainObject(answer) ? answer : {}
  const fields = form.filter((field) => field.key !== secretKey)
  const known = new Set(fields.map((field) => field.key))

  for (const key of Object.keys(input)) {
    if (!known.has(key)) return { ok: false, problem: { field: key, reason: "unknown" } }
  }

  const value: ProviderFormAnswer = {}
  for (const field of fields) {
    const entry = input[field.key]
    const problem = validValue(field, entry)
    if (problem) return { ok: false, problem }
    if (!isMissing(entry)) {
      value[field.key] = entry as ProviderFormAnswer[string]
    }
  }
  return { ok: true, value }
}
