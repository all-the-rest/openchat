import {
  MAX_CELL_CHARS,
  MAX_FORMULAS,
  MAX_HEADERS,
  MAX_MARKDOWN_BYTES,
  MAX_OUTPUT_NAME,
  MAX_PARAGRAPHS,
  MAX_ROWS,
  MAX_TITLE,
  MAX_VALUE_CHARS,
  MAX_VALUES,
} from "./limits"
import type { DocxFromTextInput } from "./validate-from-text"
import { validateDocxFromText } from "./validate-from-text"
import type { DocumentsConvertInput, DocumentsFillInput } from "./validate-documents"
import { validateDocumentsConvert, validateDocumentsFill } from "./validate-documents"

/**
 * Argument validation for the document tools. Every rejection is one short
 * line with a field name, never a value and never a stack trace. The order is
 * cheap shape first, then elements, then cross-field rules, so the model gets
 * one decisive message per call.
 */

export const TOOL_NAMES = [
  "docx_fill",
  "docx_from_text",
  "xlsx_write",
  "pdf_from_markdown",
  "read_document",
  "documents_fill",
  "documents_convert",
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export interface DocxFillInput {
  title: string
  outputName: string
  paragraphs?: string[]
  templateArtifactID?: string
  values: Record<string, string>
}

export interface XlsxWriteInput {
  title: string
  outputName: string
  sheet: string
  headers: string[]
  rows: Array<Array<string | number | boolean | null>>
  formulas: Record<string, string>
}

export interface PdfFromMarkdownInput {
  title: string
  outputName: string
  markdown: string
}

export interface ReadDocumentInput {
  sourceArtifactID: string
  title?: string
}

export type ValidatedCall =
  | { name: "docx_fill"; value: DocxFillInput }
  | { name: "docx_from_text"; value: DocxFromTextInput }
  | { name: "xlsx_write"; value: XlsxWriteInput }
  | { name: "pdf_from_markdown"; value: PdfFromMarkdownInput }
  | { name: "read_document"; value: ReadDocumentInput }
  | { name: "documents_fill"; value: DocumentsFillInput }
  | { name: "documents_convert"; value: DocumentsConvertInput }

export type ValidationResult =
  | { ok: true; value: ValidatedCall }
  | { ok: false; error: string }

type Field<T> = { ok: true; value: T } | { ok: false; error: string }

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const ARTIFACT_ID = /^[0-9a-f]{64}$/
const VALUE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const CELL_REFERENCE = /^[A-Z]{1,3}[1-9][0-9]{0,4}$/
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function text(value: unknown): value is string {
  return typeof value === "string" && !CONTROL_CHARACTERS.test(value)
}

function readTitle(value: unknown, required: boolean): Field<string | undefined> {
  if (value === undefined || value === null) {
    return required ? bad("title: must be a string") : { ok: true, value: undefined }
  }
  if (typeof value !== "string") return bad("title: must be a string")
  const trimmed = value.trim()
  if (trimmed.length === 0) return bad("title: must not be empty")
  if (CONTROL_CHARACTERS.test(trimmed)) return bad("title: contains a control character")
  const length = [...trimmed].length
  if (length > MAX_TITLE) return bad(`title: ${length} characters > ${MAX_TITLE}`)
  return { ok: true, value: trimmed }
}

function stemOf(title: string): string {
  const flattened = title
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.]+/, "")
  const capped = [...flattened].slice(0, MAX_OUTPUT_NAME - 8).join("").trim()
  return capped.length > 0 ? capped : "document"
}

function readOutputName(
  value: unknown,
  title: string,
  extension: string,
): Field<string> {
  if (value === undefined || value === null) {
    return { ok: true, value: `${stemOf(title)}${extension}` }
  }
  if (typeof value !== "string") return bad("outputName: must be a string")
  const trimmed = value.trim()
  if (trimmed.length === 0) return bad("outputName: must not be empty")
  if (trimmed.length > MAX_OUTPUT_NAME) {
    return bad(`outputName: ${trimmed.length} characters > ${MAX_OUTPUT_NAME}`)
  }
  if (!OUTPUT_NAME.test(trimmed)) return bad("outputName: use letters, digits, space, dot, dash or underscore")
  if (!trimmed.toLowerCase().endsWith(extension)) {
    return bad(`outputName: must end with ${extension}`)
  }
  return { ok: true, value: trimmed }
}

function readStringList(
  value: unknown,
  field: string,
  min: number,
  max: number,
  maxChars: number,
): Field<string[]> {
  if (!Array.isArray(value)) return bad(`${field}: must be an array`)
  if (value.length < min) return bad(`${field}: at least ${min} entr${min === 1 ? "y" : "ies"} required`)
  if (value.length > max) return bad(`${field}: ${value.length} entries > ${max}`)
  const result: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (!text(item)) return bad(`${field}[${index}]: must be a plain string`)
    if (item.length > maxChars) {
      return bad(`${field}[${index}]: ${item.length} characters > ${maxChars}`)
    }
    result.push(item)
  }
  return { ok: true, value: result }
}

function readValues(value: unknown): Field<Record<string, string>> {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (!isRecord(value)) return bad("values: must be an object")
  const entries = Object.entries(value)
  if (entries.length > MAX_VALUES) return bad(`values: ${entries.length} entries > ${MAX_VALUES}`)
  const result: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (!VALUE_KEY.test(key)) return bad(`values.${key}: use letters, digits, underscore, dot or dash`)
    if (typeof item !== "string") return bad(`values.${key}: must be a string`)
    if (!text(item)) return bad(`values.${key}: contains a control character`)
    if (item.length > MAX_VALUE_CHARS) {
      return bad(`values.${key}: ${item.length} characters > ${MAX_VALUE_CHARS}`)
    }
    result[key] = item
  }
  return { ok: true, value: result }
}

function readCell(item: unknown, row: number, column: number): Field<string | number | boolean | null> {
  if (item === null || typeof item === "boolean") return { ok: true, value: item }
  if (typeof item === "number") {
    if (!Number.isFinite(item)) return bad(`rows[${row}][${column}]: must be a finite number`)
    return { ok: true, value: item }
  }
  if (typeof item === "string") {
    if (!text(item)) return bad(`rows[${row}][${column}]: contains a control character`)
    if (item.length > MAX_CELL_CHARS) {
      return bad(`rows[${row}][${column}]: ${item.length} characters > ${MAX_CELL_CHARS}`)
    }
    if (item.startsWith("=")) {
      return bad(`rows[${row}][${column}]: start = only through the formulas map`)
    }
    return { ok: true, value: item }
  }
  return bad(`rows[${row}][${column}]: must be a string, number, boolean or null`)
}

function readRows(value: unknown, width: number): Field<Array<Array<string | number | boolean | null>>> {
  if (!Array.isArray(value)) return bad("rows: must be an array")
  if (value.length > MAX_ROWS) return bad(`rows: ${value.length} rows > ${MAX_ROWS}`)
  const rows: Array<Array<string | number | boolean | null>> = []
  for (let rowIndex = 0; rowIndex < value.length; rowIndex += 1) {
    const row = value[rowIndex]
    if (!Array.isArray(row)) return bad(`rows[${rowIndex}]: must be an array`)
    if (row.length !== width) {
      return bad(`rows[${rowIndex}]: expected ${width} cells, got ${row.length}`)
    }
    const cells: Array<string | number | boolean | null> = []
    for (let column = 0; column < row.length; column += 1) {
      const cell = readCell(row[column], rowIndex, column)
      if (!cell.ok) return cell
      cells.push(cell.value)
    }
    rows.push(cells)
  }
  return { ok: true, value: rows }
}

function readFormulas(value: unknown): Field<Record<string, string>> {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (!isRecord(value)) return bad("formulas: must be an object")
  const entries = Object.entries(value)
  if (entries.length > MAX_FORMULAS) {
    return bad(`formulas: ${entries.length} entries > ${MAX_FORMULAS}`)
  }
  const result: Record<string, string> = {}
  for (const [reference, formula] of entries) {
    if (!CELL_REFERENCE.test(reference)) return bad(`formulas.${reference}: not a cell reference`)
    if (typeof formula !== "string" || formula.trim().length === 0) {
      return bad(`formulas.${reference}: must be a non-empty string`)
    }
    if (formula.length > 200) return bad(`formulas.${reference}: longer than 200 characters`)
    result[reference] = formula.trim()
  }
  return { ok: true, value: result }
}

function readSheet(value: unknown): Field<string> {
  if (typeof value !== "string") return bad("sheet: must be a string")
  const name = value.trim()
  if (name.length === 0) return bad("sheet: must not be empty")
  if (name.length > 31) return bad("sheet: longer than 31 characters")
  if (/[\\/?*[\]:]/.test(name)) return bad("sheet: must not contain \\ / ? * [ ] :")
  if (name.startsWith("'") || name.endsWith("'")) return bad("sheet: must not start or end with '")
  return { ok: true, value: name }
}

function readArtifactID(value: unknown, field: string): Field<string> {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) {
    return bad(`${field}: expected 64 lowercase hex characters`)
  }
  return { ok: true, value }
}

function validateDocx(input: Record<string, unknown>): ValidationResult {
  const title = readTitle(input.title, true)
  if (!title.ok) return title
  const hasTemplate = input.templateArtifactID !== undefined && input.templateArtifactID !== null
  const hasParagraphs = input.paragraphs !== undefined && input.paragraphs !== null
  if (hasTemplate === hasParagraphs) {
    return bad("input: pass exactly one of paragraphs or templateArtifactID")
  }

  const outputName = readOutputName(input.outputName, title.value ?? "", ".docx")
  if (!outputName.ok) return outputName
  const values = readValues(input.values)
  if (!values.ok) return values

  if (hasTemplate) {
    const templateArtifactID = readArtifactID(input.templateArtifactID, "templateArtifactID")
    if (!templateArtifactID.ok) return templateArtifactID
    return {
      ok: true,
      value: {
        name: "docx_fill",
        value: {
          title: title.value ?? "",
          outputName: outputName.value,
          templateArtifactID: templateArtifactID.value,
          values: values.value,
        },
      },
    }
  }

  const paragraphs = readStringList(input.paragraphs, "paragraphs", 1, MAX_PARAGRAPHS, MAX_VALUE_CHARS)
  if (!paragraphs.ok) return paragraphs
  return {
    ok: true,
    value: {
      name: "docx_fill",
      value: {
        title: title.value ?? "",
        outputName: outputName.value,
        paragraphs: paragraphs.value,
        values: values.value,
      },
    },
  }
}

function validateXlsx(input: Record<string, unknown>): ValidationResult {
  const title = readTitle(input.title, true)
  if (!title.ok) return title
  const outputName = readOutputName(input.outputName, title.value ?? "", ".xlsx")
  if (!outputName.ok) return outputName
  const sheet = readSheet(input.sheet)
  if (!sheet.ok) return sheet
  const headers = readStringList(input.headers, "headers", 1, MAX_HEADERS, MAX_CELL_CHARS)
  if (!headers.ok) return headers
  const rows = readRows(input.rows, headers.value.length)
  if (!rows.ok) return rows
  const formulas = readFormulas(input.formulas)
  if (!formulas.ok) return formulas

  return {
    ok: true,
    value: {
      name: "xlsx_write",
      value: {
        title: title.value ?? "",
        outputName: outputName.value,
        sheet: sheet.value,
        headers: headers.value,
        rows: rows.value,
        formulas: formulas.value,
      },
    },
  }
}

function validatePdf(input: Record<string, unknown>): ValidationResult {
  const title = readTitle(input.title, true)
  if (!title.ok) return title
  const outputName = readOutputName(input.outputName, title.value ?? "", ".pdf")
  if (!outputName.ok) return outputName
  if (typeof input.markdown !== "string") return bad("markdown: must be a string")
  if (input.markdown.trim().length === 0) return bad("markdown: must not be empty")
  const bytes = Buffer.byteLength(input.markdown, "utf8")
  if (bytes > MAX_MARKDOWN_BYTES) {
    return bad(`markdown: ${Math.ceil(bytes / 1024)} KiB > ${MAX_MARKDOWN_BYTES / 1024} KiB`)
  }
  return {
    ok: true,
    value: {
      name: "pdf_from_markdown",
      value: { title: title.value ?? "", outputName: outputName.value, markdown: input.markdown },
    },
  }
}

function validateRead(input: Record<string, unknown>): ValidationResult {
  const sourceArtifactID = readArtifactID(input.sourceArtifactID, "sourceArtifactID")
  if (!sourceArtifactID.ok) return sourceArtifactID
  const title = readTitle(input.title, false)
  if (!title.ok) return title
  return {
    ok: true,
    value: {
      name: "read_document",
      value: {
        sourceArtifactID: sourceArtifactID.value,
        ...(title.value === undefined ? {} : { title: title.value }),
      },
    },
  }
}

export function validateTool(name: string, input: unknown): ValidationResult {
  if (!isRecord(input)) return bad("input: expected an object")
  switch (name) {
    case "docx_fill":
      return validateDocx(input)
    case "docx_from_text":
      return validateDocxFromText(input)
    case "xlsx_write":
      return validateXlsx(input)
    case "pdf_from_markdown":
      return validatePdf(input)
    case "read_document":
      return validateRead(input)
    case "documents_fill":
      return validateDocumentsFill(input)
    case "documents_convert":
      return validateDocumentsConvert(input)
    default:
      return bad("input: unknown tool")
  }
}
