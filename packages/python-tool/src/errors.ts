/**
 * Stable error codes and their one-line, model-facing messages.
 *
 * The model never sees stderr, a Python traceback or a library message: the
 * runner classifies a failure into one of these codes and the tool answers the
 * fixed text below. Tests assert both the mapping and the absence of raw text.
 */

export const ERROR_TEXT = {
  python_missing:
    "runtime: the Python interpreter is missing; run `pnpm run setup:python` (or set OPENCHAT_PYTHON)",
  timeout: "timeout: the document tool ran longer than its limit and was stopped",
  memory: "memory: the document tool exceeded its memory cap",
  crashed: "internal: the document tool failed before it produced a result",
  invalid_output: "internal: the document tool returned an unexpected result",
  too_large: "size: the generated file is too large for one artifact",
  macro_document: "unsupported: macro-enabled documents (.docm/.xlsm) are rejected",
  unsupported_document: "unsupported: only .docx, .xlsx and .pdf are readable",
  empty_document: "unsupported: the document contains no extractable text",
} as const

export type ErrorCode = keyof typeof ERROR_TEXT

const CODES = new Set<string>(Object.keys(ERROR_TEXT))

/** True for a code the Python side may report; anything else is `crashed`. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODES.has(value)
}

/** The fixed message for a code; unknown input cannot reach the model. */
export function errorText(code: string): string {
  return isErrorCode(code) ? ERROR_TEXT[code] : ERROR_TEXT.crashed
}
