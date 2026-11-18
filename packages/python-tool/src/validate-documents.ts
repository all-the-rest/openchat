import {
  MAX_OUTPUT_NAME,
  MAX_TEMPLATE_PATH_CHARS,
  MAX_VALUE_CHARS,
  MAX_VALUES,
} from "./limits"

/**
 * Argument validation for the two chat-file document tools. Kept in its own
 * module so `validate.ts` stays under the 400-line ceiling. Every rejection is
 * one short line with a field name, never a value and never a stack trace. The
 * small primitives below mirror `validate.ts` so this module is self-contained
 * (no import cycle) and the two callers share identical messages.
 */

/** Structured placeholders let `{% for %}` loops be filled from a .dotx. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface DocumentsFillInput {
  templatePath: string
  values: Record<string, JsonValue>
  name?: string
}

export interface DocumentsConvertInput {
  templatePath: string
  name?: string
}

type Field<T> = { ok: true; value: T } | { ok: false; error: string }

type DocCall<N extends string, V> = { ok: true; value: { name: N; value: V } }

export type DocumentsValidationResult =
  | DocCall<"documents_fill", DocumentsFillInput>
  | DocCall<"documents_convert", DocumentsConvertInput>
  | { ok: false; error: string }

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const VALUE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/

const MAX_JSON_DEPTH = 4
const MAX_JSON_ARRAY = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function text(value: unknown): value is string {
  return typeof value === "string" && !CONTROL_CHARACTERS.test(value)
}

function readJsonValue(value: unknown, at: string, depth: number): Field<JsonValue> {
  if (depth > MAX_JSON_DEPTH) return bad(`${at}: nested too deeply`)
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return { ok: true, value: value as JsonValue }
  }
  if (typeof value === "string") {
    if (!text(value)) return bad(`${at}: contains a control character`)
    if (value.length > MAX_VALUE_CHARS) return bad(`${at}: longer than ${MAX_VALUE_CHARS} characters`)
    return { ok: true, value }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) return bad(`${at}: ${value.length} entries > ${MAX_JSON_ARRAY}`)
    const items: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const entry = readJsonValue(value[index], `${at}[${index}]`, depth + 1)
      if (!entry.ok) return entry
      items.push(entry.value)
    }
    return { ok: true, value: items }
  }
  if (isRecord(value)) return readStructuredValues(value, at, depth)
  return bad(`${at}: must be a JSON scalar, array or object`)
}

/** Scalars and simple lists/maps are accepted; the other tools stay string-only. */
function readStructuredValues(value: unknown, at = "values", depth = 0): Field<Record<string, JsonValue>> {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (!isRecord(value)) return bad(`${at}: must be an object`)
  const entries = Object.entries(value)
  if (entries.length > MAX_VALUES) return bad(`${at}: ${entries.length} entries > ${MAX_VALUES}`)
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of entries) {
    if (!VALUE_KEY.test(key) || key.includes("..")) {
      return bad(`${at}.${key}: use letters, digits, underscore, dot or dash`)
    }
    const entry = readJsonValue(item, `${at}.${key}`, depth + 1)
    if (!entry.ok) return entry
    result[key] = entry.value
  }
  return { ok: true, value: result }
}

function readTemplatePath(value: unknown, extension: "fill" | "convert"): Field<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return bad("templatePath: must be a non-empty string")
  }
  const path = value.trim()
  if ([...path].length > MAX_TEMPLATE_PATH_CHARS) {
    return bad(`templatePath: longer than ${MAX_TEMPLATE_PATH_CHARS} characters`)
  }
  if (!text(path)) return bad("templatePath: contains a control character")
  if (path.startsWith("/") || path.includes("\\") || path.includes("..")) {
    return bad("templatePath: use a path inside WORKSPACE_DIR/chats")
  }
  const parts = path.split("/")
  if (parts.length !== 3 || parts[1] !== "files") {
    return bad("templatePath: expected <sessionID>/files/<name>")
  }
  const allowed = extension === "fill" ? /\.(docx|dotx)$/i : /\.docx$/i
  if (!allowed.test(parts[2] ?? "")) {
    return bad(`templatePath: must end with ${extension === "fill" ? ".docx or .dotx" : ".docx"}`)
  }
  return { ok: true, value: path }
}

function readChatOutputName(value: unknown): Field<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== "string" || !text(value)) return bad("name: must be a plain string")
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_OUTPUT_NAME) return bad("name: must be 1-120 characters")
  if (!OUTPUT_NAME.test(trimmed)) return bad("name: use letters, digits, space, dot, dash or underscore")
  return { ok: true, value: trimmed }
}

export function validateDocumentsFill(input: Record<string, unknown>): DocumentsValidationResult {
  const templatePath = readTemplatePath(input.templatePath, "fill")
  if (!templatePath.ok) return templatePath
  const values = readStructuredValues(input.values)
  if (!values.ok) return values
  const name = readChatOutputName(input.name)
  if (!name.ok) return name
  return {
    ok: true,
    value: {
      name: "documents_fill",
      value: {
        templatePath: templatePath.value,
        values: values.value,
        ...(name.value === undefined ? {} : { name: name.value }),
      },
    },
  }
}

export function validateDocumentsConvert(input: Record<string, unknown>): DocumentsValidationResult {
  const templatePath = readTemplatePath(input.templatePath, "convert")
  if (!templatePath.ok) return templatePath
  const name = readChatOutputName(input.name)
  if (!name.ok) return name
  return {
    ok: true,
    value: {
      name: "documents_convert",
      value: {
        templatePath: templatePath.value,
        ...(name.value === undefined ? {} : { name: name.value }),
      },
    },
  }
}
