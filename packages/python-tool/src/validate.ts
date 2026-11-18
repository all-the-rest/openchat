import { ARTIFACT_TITLE_MAX } from "@openchat/contracts"

/**
 * Argument validators for the four document tools.
 *
 * They run before any process starts, so a rejection costs no Python run and
 * carries one precise sentence the model can act on. No validator accepts a
 * filesystem path: byte inputs travel as base64 and are written by the runner
 * into its own temp dir under a fixed name.
 */

/** Largest accepted template or input document, decoded. */
export const MAX_DOCUMENT_BYTES = 8_388_608
/** Paragraph list bounds for a DOCX built from scratch or filled. */
export const MAX_PARAGRAPHS = 200
export const MAX_PARAGRAPH_CHARS = 20_000
export const MAX_DOCX_TEXT_CHARS = 200_000
/** Placeholder map bounds. */
export const MAX_VALUES = 100
export const MAX_VALUE_CHARS = 2_000
/** Spreadsheet bounds. */
export const MAX_SHEETS = 10
export const MAX_ROWS_PER_SHEET = 5_000
export const MAX_CELLS_PER_ROW = 100
export const MAX_CELL_CHARS = 5_000
/** Markdown input for the PDF tool. */
export const MAX_MARKDOWN_CHARS = 200_000
/** Longest accepted output file name. */
const MAX_NAME_CHARS = 120
/** `chats/<session>/files/<name>` is short; anything longer is not a template. */
export const MAX_TEMPLATE_PATH_CHARS = 300
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,119}$/

const PLACEHOLDER_KEY = /^[A-Za-z0-9_.-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/
const OUTPUT_EXTENSIONS = [".docx", ".xlsx", ".pdf"] as const

export type Cell = string | number | boolean | null

export interface SheetInput {
  name: string
  rows: Cell[][]
}

export interface DocxFillInput {
  title: string
  paragraphs: string[]
  /** Present when the caller fills an uploaded template instead of building one. */
  template?: Uint8Array
  values: Record<string, string>
}

export interface XlsxWriteInput {
  title: string
  sheets: SheetInput[]
}

export interface PdfFromMarkdownInput {
  title: string
  markdown: string
}

export type DocumentKind = "docx" | "xlsx" | "pdf"

export interface ReadDocumentInput {
  name: string
  kind: DocumentKind
  bytes: Uint8Array
}

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
  name: string
}

export interface DocumentExtractInput {
  name: string
  bytes: Uint8Array
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export function kib(bytes: number): number {
  return Math.ceil(bytes / 1024)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}


function validateTitle(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return { ok: false, error: "title: must be a string" }
  const title = value.trim()
  if (title.length === 0) return { ok: false, error: "title: must not be empty" }
  const length = [...title].length
  if (length > ARTIFACT_TITLE_MAX) {
    return { ok: false, error: `title: ${length} characters > ${ARTIFACT_TITLE_MAX}` }
  }
  return { ok: true, value: title }
}

/**
 * Strict base64: the alphabet only, padded to a multiple of four, and capped
 * before decoding so a huge string cannot allocate a larger buffer first.
 */
export function decodeBase64(
  value: unknown,
  field: string,
  maxBytes: number,
): ValidationResult<Uint8Array> {
  if (typeof value !== "string") return { ok: false, error: `${field}: must be a base64 string` }
  if (value.length === 0) return { ok: false, error: `${field}: must not be empty` }
  const maxEncoded = Math.ceil((maxBytes * 4) / 3) + 4
  if (value.length > maxEncoded) {
    return { ok: false, error: `${field}: larger than ${kib(maxBytes)} KiB` }
  }
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    return { ok: false, error: `${field}: must be valid base64` }
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"))
  if (bytes.byteLength === 0) return { ok: false, error: `${field}: must not be empty` }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: `${field}: larger than ${kib(maxBytes)} KiB` }
  }
  return { ok: true, value: bytes }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false
  return prefix.every((byte, index) => bytes[index] === byte)
}

/** ZIP magic: every OOXML package starts with it. */
const ZIP_PREFIX = [0x50, 0x4b, 0x03, 0x04]
const PDF_PREFIX = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

function validateParagraphs(value: unknown): ValidationResult<string[]> {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, error: "paragraphs: must be an array of strings" }
  if (value.length > MAX_PARAGRAPHS) {
    return { ok: false, error: `paragraphs: ${value.length} entries > ${MAX_PARAGRAPHS}` }
  }
  const paragraphs: string[] = []
  let totalCharacters = 0
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      return { ok: false, error: `paragraphs[${index}]: must be a string` }
    }
    const characters = [...entry].length
    if (characters > MAX_PARAGRAPH_CHARS) {
      return {
        ok: false,
        error: `paragraphs[${index}]: longer than ${MAX_PARAGRAPH_CHARS} characters`,
      }
    }
    if (CONTROL_CHARACTERS.test(entry)) {
      return { ok: false, error: `paragraphs[${index}]: contains a control character` }
    }
    totalCharacters += characters
    if (totalCharacters > MAX_DOCX_TEXT_CHARS) {
      return { ok: false, error: `paragraphs: total text larger than ${MAX_DOCX_TEXT_CHARS} characters` }
    }
    paragraphs.push(entry)
  }
  return { ok: true, value: paragraphs }
}

function validateValues(value: unknown): ValidationResult<Record<string, string>> {
  if (value === undefined) return { ok: true, value: {} }
  if (!isRecord(value)) return { ok: false, error: "values: must be an object of strings" }
  const entries = Object.entries(value)
  if (entries.length > MAX_VALUES) {
    return { ok: false, error: `values: ${entries.length} keys > ${MAX_VALUES}` }
  }
  const values: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (!PLACEHOLDER_KEY.test(key)) {
      return {
        ok: false,
        error: `values.${key}: placeholder keys are letters, digits, dot, dash or underscore`,
      }
    }
    if (typeof entry !== "string") {
      return { ok: false, error: `values.${key}: must be a string` }
    }
    if ([...entry].length > MAX_VALUE_CHARS) {
      return { ok: false, error: `values.${key}: longer than ${MAX_VALUE_CHARS} characters` }
    }
    if (CONTROL_CHARACTERS.test(entry)) {
      return { ok: false, error: `values.${key}: contains a control character` }
    }
    values[key] = entry
  }
  return { ok: true, value: values }
}

export function validateDocxFill(input: unknown): ValidationResult<DocxFillInput> {
  if (!isRecord(input)) {
    return { ok: false, error: "input: expected an object with title and paragraphs or template" }
  }
  const title = validateTitle(input.title)
  if (!title.ok) return title

  const paragraphs = validateParagraphs(input.paragraphs)
  if (!paragraphs.ok) return paragraphs
  const values = validateValues(input.values)
  if (!values.ok) return values

  if (input.template === undefined || input.template === null) {
    if (paragraphs.value.length === 0) {
      return { ok: false, error: "input: pass paragraphs or a template" }
    }
    return { ok: true, value: { title: title.value, paragraphs: paragraphs.value, values: values.value } }
  }

  const template = decodeBase64(input.template, "template", MAX_DOCUMENT_BYTES)
  if (!template.ok) return template
  if (!startsWith(template.value, ZIP_PREFIX)) {
    return { ok: false, error: "template: not a .docx package (ZIP magic missing)" }
  }
  return {
    ok: true,
    value: {
      title: title.value,
      paragraphs: paragraphs.value,
      template: template.value,
      values: values.value,
    },
  }
}

function validateSheetName(value: unknown, index: number): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, error: `sheets[${index}].name: must be a string` }
  }
  const name = value.trim()
  if (name.length === 0) return { ok: false, error: `sheets[${index}].name: must not be empty` }
  if ([...name].length > 31) {
    return { ok: false, error: `sheets[${index}].name: longer than 31 characters` }
  }
  if (SHEET_NAME_FORBIDDEN.test(name) || name.startsWith("'") || name.endsWith("'")) {
    return {
      ok: false,
      error: `sheets[${index}].name: must not contain []:*?/\\ or start/end with an apostrophe`,
    }
  }
  return { ok: true, value: name }
}

function validateCell(value: unknown, sheet: number, row: number, cell: number): ValidationResult<Cell> {
  const at = `sheets[${sheet}].rows[${row}][${cell}]`
  if (value === null || typeof value === "boolean") return { ok: true, value }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, error: `${at}: must be a finite number` }
    return { ok: true, value }
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${at}: must be a string, number, boolean or null` }
  }
  if ([...value].length > MAX_CELL_CHARS) {
    return { ok: false, error: `${at}: longer than ${MAX_CELL_CHARS} characters` }
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return { ok: false, error: `${at}: contains a control character` }
  }
  return { ok: true, value }
}

export function validateXlsxWrite(input: unknown): ValidationResult<XlsxWriteInput> {
  if (!isRecord(input)) {
    return { ok: false, error: "input: expected an object with title and sheets" }
  }
  const title = validateTitle(input.title)
  if (!title.ok) return title
  if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
    return { ok: false, error: "sheets: must be a non-empty array" }
  }
  if (input.sheets.length > MAX_SHEETS) {
    return { ok: false, error: `sheets: ${input.sheets.length} > ${MAX_SHEETS}` }
  }

  const seen = new Set<string>()
  const sheets: SheetInput[] = []
  for (const [sheetIndex, raw] of input.sheets.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `sheets[${sheetIndex}]: must be an object` }
    const name = validateSheetName(raw.name, sheetIndex)
    if (!name.ok) return name
    if (seen.has(name.value.toLowerCase())) {
      return { ok: false, error: `sheets[${sheetIndex}].name: duplicate sheet name` }
    }
    seen.add(name.value.toLowerCase())
    if (!Array.isArray(raw.rows) || raw.rows.length === 0) {
      return { ok: false, error: `sheets[${sheetIndex}].rows: must be a non-empty array` }
    }
    if (raw.rows.length > MAX_ROWS_PER_SHEET) {
      return {
        ok: false,
        error: `sheets[${sheetIndex}].rows: ${raw.rows.length} > ${MAX_ROWS_PER_SHEET}`,
      }
    }
    const rows: Cell[][] = []
    for (const [rowIndex, rawRow] of raw.rows.entries()) {
      if (!Array.isArray(rawRow) || rawRow.length === 0) {
        return { ok: false, error: `sheets[${sheetIndex}].rows[${rowIndex}]: must be a non-empty array` }
      }
      if (rawRow.length > MAX_CELLS_PER_ROW) {
        return {
          ok: false,
          error: `sheets[${sheetIndex}].rows[${rowIndex}]: ${rawRow.length} cells > ${MAX_CELLS_PER_ROW}`,
        }
      }
      const cells: Cell[] = []
      for (const [cellIndex, rawCell] of rawRow.entries()) {
        const cell = validateCell(rawCell, sheetIndex, rowIndex, cellIndex)
        if (!cell.ok) return cell
        cells.push(cell.value)
      }
      rows.push(cells)
    }
    sheets.push({ name: name.value, rows })
  }
  return { ok: true, value: { title: title.value, sheets } }
}

export function validatePdfFromMarkdown(input: unknown): ValidationResult<PdfFromMarkdownInput> {
  if (!isRecord(input)) {
    return { ok: false, error: "input: expected an object with title and markdown" }
  }
  const title = validateTitle(input.title)
  if (!title.ok) return title
  if (typeof input.markdown !== "string") {
    return { ok: false, error: "markdown: must be a string" }
  }
  if (input.markdown.trim().length === 0) {
    return { ok: false, error: "markdown: must not be empty" }
  }
  if ([...input.markdown].length > MAX_MARKDOWN_CHARS) {
    return { ok: false, error: `markdown: longer than ${MAX_MARKDOWN_CHARS} characters` }
  }
  if (CONTROL_CHARACTERS.test(input.markdown)) {
    return { ok: false, error: "markdown: contains a control character" }
  }
  return { ok: true, value: { title: title.value, markdown: input.markdown } }
}

function documentKind(name: string): DocumentKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".xlsx")) return "xlsx"
  if (lower.endsWith(".pdf")) return "pdf"
  return null
}

export function validateReadDocument(input: unknown): ValidationResult<ReadDocumentInput> {
  if (!isRecord(input)) {
    return { ok: false, error: "input: expected an object with name and base64" }
  }
  if (typeof input.name !== "string") return { ok: false, error: "name: must be a string" }
  const name = input.name.trim()
  if (name.length === 0) return { ok: false, error: "name: must not be empty" }
  if ([...name].length > MAX_NAME_CHARS) {
    return { ok: false, error: `name: longer than ${MAX_NAME_CHARS} characters` }
  }
  if (name.includes("/") || name.includes("\\") || name.startsWith(".") || name.includes("..")) {
    return { ok: false, error: "name: must be one file name, not a path" }
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return { ok: false, error: "name: contains a control character" }
  }
  const kind = documentKind(name)
  if (!kind) return { ok: false, error: `name: ${OUTPUT_EXTENSIONS.join(", ")} only` }

  const bytes = decodeBase64(input.base64, "document", MAX_DOCUMENT_BYTES)
  if (!bytes.ok) return bytes
  if (kind === "pdf" && !startsWith(bytes.value, PDF_PREFIX)) {
    return { ok: false, error: "document: not a PDF (%PDF- magic missing)" }
  }
  if (kind !== "pdf" && !startsWith(bytes.value, ZIP_PREFIX)) {
    return { ok: false, error: `document: not a .${kind} package (ZIP magic missing)` }
  }
  return { ok: true, value: { name, kind, bytes: bytes.value } }
}

const MAX_VALUE_DEPTH = 4
const MAX_ARRAY_ENTRIES = 200

function validateJsonValue(value: unknown, at: string, depth: number): ValidationResult<JsonValue> {
  if (depth > MAX_VALUE_DEPTH) return { ok: false, error: `${at}: nested too deeply` }
  if (value === null || typeof value === "boolean") return { ok: true, value }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, error: `${at}: must be a finite number` }
  }
  if (typeof value === "string") {
    if ([...value].length > MAX_VALUE_CHARS) {
      return { ok: false, error: `${at}: longer than ${MAX_VALUE_CHARS} characters` }
    }
    return CONTROL_CHARACTERS.test(value)
      ? { ok: false, error: `${at}: contains a control character` }
      : { ok: true, value }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ENTRIES) {
      return { ok: false, error: `${at}: ${value.length} entries > ${MAX_ARRAY_ENTRIES}` }
    }
    const items: JsonValue[] = []
    for (const [index, entry] of value.entries()) {
      const item = validateJsonValue(entry, `${at}[${index}]`, depth + 1)
      if (!item.ok) return item
      items.push(item.value)
    }
    return { ok: true, value: items }
  }
  if (isRecord(value)) {
    return validateStructuredValues(value, at, depth)
  }
  return { ok: false, error: `${at}: must be a JSON scalar, array or object` }
}

/** Placeholder values may be scalars or simple nested lists/maps for loops. */
export function validateStructuredValues(
  value: unknown,
  at = "values",
  depth = 0,
): ValidationResult<Record<string, JsonValue>> {
  if (value === undefined) return { ok: true, value: {} }
  if (!isRecord(value)) return { ok: false, error: `${at}: must be an object` }
  const entries = Object.entries(value)
  if (entries.length > MAX_VALUES) {
    return { ok: false, error: `${at}: ${entries.length} keys > ${MAX_VALUES}` }
  }
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of entries) {
    if (!PLACEHOLDER_KEY.test(key) || key.includes("..")) {
      return { ok: false, error: `${at}.${key}: keys are letters, digits, dot, dash or underscore` }
    }
    const checked = validateJsonValue(entry, `${at}.${key}`, depth + 1)
    if (!checked.ok) return checked
    result[key] = checked.value
  }
  return { ok: true, value: result }
}

export function validateDocumentsFill(input: unknown): ValidationResult<DocumentsFillInput> {
  if (!isRecord(input)) {
    return { ok: false, error: "input: expected templatePath, values and an optional name" }
  }
  if (typeof input.templatePath !== "string" || input.templatePath.trim().length === 0) {
    return { ok: false, error: "templatePath: must be a non-empty string" }
  }
  const templatePath = input.templatePath.trim()
  if ([...templatePath].length > MAX_TEMPLATE_PATH_CHARS) {
    return { ok: false, error: `templatePath: longer than ${MAX_TEMPLATE_PATH_CHARS} characters` }
  }
  if (CONTROL_CHARACTERS.test(templatePath) || templatePath.includes("\u0000")) {
    return { ok: false, error: "templatePath: contains a control character" }
  }
  if (templatePath.includes("..") || templatePath.includes("\\") || templatePath.startsWith("/")) {
    return { ok: false, error: "templatePath: use a path inside WORKSPACE_DIR/chats" }
  }
  const segments = templatePath.split("/")
  if (segments.length !== 3 || segments[1] !== "files") {
    return { ok: false, error: "templatePath: expected chats/<sessionID>/files/<name>" }
  }
  if (!/\.(docx|dotx)$/i.test(templatePath)) {
    return { ok: false, error: "templatePath: only .docx and .dotx templates are accepted" }
  }
  const values = validateStructuredValues(input.values)
  if (!values.ok) return values
  let name = "document"
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !OUTPUT_NAME_PATTERN.test(input.name)) {
      return { ok: false, error: "name: letters, digits, space, dot, dash and underscore only" }
    }
    name = input.name
  }
  return { ok: true, value: { templatePath, values: values.value, name } }
}

const EXTRACT_EXTENSIONS = [
  ".csv", ".docx", ".html", ".htm", ".json", ".md", ".pdf",
  ".pptx", ".txt", ".xlsx", ".xml", ".zip",
] as const

export function validateDocumentExtract(input: unknown): ValidationResult<DocumentExtractInput> {
  if (!isRecord(input)) {
    return { ok: false, error: "input: expected an object with name and base64" }
  }
  if (typeof input.name !== "string") return { ok: false, error: "name: must be a string" }
  const name = input.name.trim()
  if (name.length === 0 || [...name].length > MAX_NAME_CHARS) {
    return { ok: false, error: `name: must be 1-${MAX_NAME_CHARS} characters` }
  }
  if (name.includes("/") || name.includes("\\") || name.startsWith(".") || name.includes("..")) {
    return { ok: false, error: "name: must be one file name, not a path" }
  }
  if (CONTROL_CHARACTERS.test(name)) return { ok: false, error: "name: contains a control character" }
  if (!EXTRACT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) {
    return { ok: false, error: `name: ${EXTRACT_EXTENSIONS.join(", ")} only` }
  }
  const bytes = decodeBase64(input.base64, "document", MAX_DOCUMENT_BYTES)
  if (!bytes.ok) return bytes
  return { ok: true, value: { name, bytes: bytes.value } }
}
