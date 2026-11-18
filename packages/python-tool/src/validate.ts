import type { ArchiveExtractInput, ArchiveListInput } from "./validate-archives"
import {
  ARCHIVE_TOOL_NAMES,
  validateArchiveExtract,
  validateArchiveList,
} from "./validate-archives"
import type { CoreValidatedCall } from "./validate-core"
import { validateDocx, validatePdf, validateRead, validateXlsx } from "./validate-core"
import type { DocumentsConvertInput, DocumentsFillInput } from "./validate-documents"
import { validateDocumentsConvert, validateDocumentsFill } from "./validate-documents"
import type { DocxFromTextInput } from "./validate-from-text"
import { validateDocxFromText } from "./validate-from-text"

/**
 * Argument validation for the document tools. Every rejection is one short
 * line with a field name, never a value and never a stack trace. This module is
 * the dispatcher: each tool group owns its rules in a sibling module
 * (`validate-core`, `validate-from-text`, `validate-documents`,
 * `validate-archives`) so this file stays under the 400-line ceiling.
 */

export type {
  DocxFillInput,
  PdfFromMarkdownInput,
  ReadDocumentInput,
  XlsxWriteInput,
} from "./validate-core"

export const DOCUMENT_TOOL_NAMES = [
  "docx_fill",
  "docx_from_text",
  "xlsx_write",
  "pdf_from_markdown",
  "read_document",
  "documents_fill",
  "documents_convert",
] as const

export const TOOL_NAMES = [...DOCUMENT_TOOL_NAMES, ...ARCHIVE_TOOL_NAMES] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export type ValidatedCall =
  | CoreValidatedCall
  | { name: "docx_from_text"; value: DocxFromTextInput }
  | { name: "documents_fill"; value: DocumentsFillInput }
  | { name: "documents_convert"; value: DocumentsConvertInput }
  | { name: "archive_list"; value: ArchiveListInput }
  | { name: "archive_extract"; value: ArchiveExtractInput }

export type ValidationResult =
  | { ok: true; value: ValidatedCall }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
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
    case "archive_list":
      return validateArchiveList(input)
    case "archive_extract":
      return validateArchiveExtract(input)
    default:
      return bad("input: unknown tool")
  }
}
