import { errorText, isErrorCode } from "./errors"
import type { ErrorCode } from "./errors"
import { decodeBase64, MAX_DOCUMENT_BYTES } from "./validate"
import type { JsonValue } from "./validate"

/**
 * Typed client for the headless documents service. One bearer token, one
 * deadline, one response cap. Service errors are mapped to our stable codes;
 * no raw body, stderr or traceback is ever returned to the model.
 */

export const DEFAULT_DOCUMENTS_TIMEOUT_MS = 40_000
export const MAX_DOCUMENTS_RESPONSE_BYTES = 24 * 1024 * 1024

export interface FillRequest {
  template: string
  values: Record<string, JsonValue>
  name: string
}

export interface FillResponse {
  docx: Uint8Array
  pdf: Uint8Array
  docxName: string
  pdfName: string
}

export interface ExtractResponse {
  markdown: string
}

export type DocumentsResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface DocumentsClientOptions {
  url: string
  token: string
  timeoutMs?: number
  maxResponseBytes?: number
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export interface DocumentsClient {
  fill(request: FillRequest): Promise<DocumentsResult<FillResponse>>
  extract(request: { name: string; base64: string }): Promise<DocumentsResult<ExtractResponse>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createDocumentsClient(options: DocumentsClientOptions): DocumentsClient {
  const timeout = options.timeoutMs ?? DEFAULT_DOCUMENTS_TIMEOUT_MS
  const responseCap = options.maxResponseBytes ?? MAX_DOCUMENTS_RESPONSE_BYTES
  const fetcher = options.fetchImpl ?? fetch

  async function post(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<DocumentsResult<Record<string, unknown>>> {
    let response: Response
    try {
      response = await fetcher(`${options.url}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      const code: ErrorCode = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "service_unavailable"
      return { ok: false, error: errorText(code) }
    }

    const declared = Number(response.headers.get("content-length") ?? "0")
    if (Number.isFinite(declared) && declared > responseCap) {
      return { ok: false, error: errorText("too_large") }
    }
    let raw: ArrayBuffer
    try {
      raw = await response.arrayBuffer()
    } catch {
      return { ok: false, error: errorText("service_unavailable") }
    }
    if (raw.byteLength > responseCap) return { ok: false, error: errorText("too_large") }

    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return { ok: false, error: errorText("service_error") }
    }
    if (!isRecord(parsed)) return { ok: false, error: errorText("service_error") }

    if (!response.ok) {
      const nested = isRecord(parsed.error) ? parsed.error : undefined
      const rawCode = nested?.code
      const code: ErrorCode = isErrorCode(rawCode) ? rawCode : "service_error"
      return { ok: false, error: errorText(code) }
    }
    return { ok: true, value: parsed }
  }

  async function fill(request: FillRequest): Promise<DocumentsResult<FillResponse>> {
    const result = await post("/fill", {
      template: request.template,
      values: request.values,
      name: request.name,
    })
    if (!result.ok) return result
    const value = result.value
    const docx = decodeBase64(value.docx, "docx", MAX_DOCUMENTS_RESPONSE_BYTES)
    const pdf = decodeBase64(value.pdf, "pdf", MAX_DOCUMENTS_RESPONSE_BYTES)
    if (!docx.ok) return { ok: false, error: docx.error }
    if (!pdf.ok) return { ok: false, error: pdf.error }
    if (typeof value.docxName !== "string" || typeof value.pdfName !== "string") {
      return { ok: false, error: errorText("invalid_output") }
    }
    return {
      ok: true,
      value: {
        docx: docx.value,
        pdf: pdf.value,
        docxName: value.docxName,
        pdfName: value.pdfName,
      },
    }
  }

  async function extract(request: {
    name: string
    base64: string
  }): Promise<DocumentsResult<ExtractResponse>> {
    const result = await post("/extract", request)
    if (!result.ok) return result
    const markdown = result.value.markdown
    if (typeof markdown !== "string") return { ok: false, error: errorText("invalid_output") }
    return { ok: true, value: { markdown } }
  }

  return { fill, extract }
}
