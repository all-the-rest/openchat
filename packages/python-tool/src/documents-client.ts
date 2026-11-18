import {
  DOCUMENTS_TIMEOUT_MS,
  MAX_DOCUMENTS_RESPONSE_BYTES,
} from "./limits"

/**
 * Typed client for the headless documents service. One bearer token, one
 * deadline, one response cap. Service codes map to fixed sentences: no raw
 * body, LibreOffice stderr or traceback is ever returned to the model.
 */

const SERVICE_ERROR = {
  invalid_template: "template: not a readable DOCX or DOTX package",
  unknown_placeholder: "values: the template has a placeholder without a value",
  render_failed: "template: the document could not be rendered",
  convert_failed: "convert: the document could not be exported as a PDF",
  macro_document: "unsupported: macro-enabled documents are rejected",
  too_large: "size: the document exceeds the service limit",
  timeout: "timeout: the conversion ran longer than its limit",
  bad_request: "input: the documents service refused the request",
  unauthorized: "service: the documents token was rejected",
  not_found: "service: the documents service has no such endpoint",
  service_error: "service: the documents service rejected the request",
  service_unavailable: "service: the documents service is unreachable; check DOCUMENTS_URL",
  invalid_output: "internal: the documents service returned an unexpected result",
} as const

type Code = keyof typeof SERVICE_ERROR
const CODES = new Set<string>(Object.keys(SERVICE_ERROR))

function codeOf(value: unknown): Code {
  return typeof value === "string" && CODES.has(value) ? (value as Code) : "service_error"
}

export interface FillRequest {
  template: string
  values: Record<string, unknown>
  name: string
}

export interface FillResponse {
  docx: Uint8Array
  pdf: Uint8Array
  docxName: string
  pdfName: string
}

export interface ConvertResponse {
  pdf: Uint8Array
  pdfName: string
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
  convert(request: { document: string; name: string }): Promise<DocumentsResult<ConvertResponse>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decode(value: unknown, field: string, cap: number): DocumentsResult<Uint8Array> {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: `${field}: the service returned no base64 data` }
  }
  if (value.length > Math.ceil((cap * 4) / 3) + 4) {
    return { ok: false, error: SERVICE_ERROR.too_large }
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return { ok: false, error: SERVICE_ERROR.invalid_output }
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"))
  if (bytes.byteLength === 0 || bytes.byteLength > cap) {
    return { ok: false, error: SERVICE_ERROR.too_large }
  }
  return { ok: true, value: bytes }
}

export function createDocumentsClient(options: DocumentsClientOptions): DocumentsClient {
  const timeout = options.timeoutMs ?? DOCUMENTS_TIMEOUT_MS
  const cap = options.maxResponseBytes ?? MAX_DOCUMENTS_RESPONSE_BYTES
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
      const code: Code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "service_unavailable"
      return { ok: false, error: SERVICE_ERROR[code] }
    }

    const declared = Number(response.headers.get("content-length") ?? "0")
    if (Number.isFinite(declared) && declared > cap) {
      return { ok: false, error: SERVICE_ERROR.too_large }
    }
    let raw: ArrayBuffer
    try {
      raw = await response.arrayBuffer()
    } catch {
      return { ok: false, error: SERVICE_ERROR.service_unavailable }
    }
    if (raw.byteLength > cap) return { ok: false, error: SERVICE_ERROR.too_large }

    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return { ok: false, error: SERVICE_ERROR.service_error }
    }
    if (!isRecord(parsed)) return { ok: false, error: SERVICE_ERROR.service_error }
    if (!response.ok) {
      const nested = isRecord(parsed.error) ? parsed.error : undefined
      return { ok: false, error: SERVICE_ERROR[codeOf(nested?.code)] }
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
    const docx = decode(result.value.docx, "docx", cap)
    if (!docx.ok) return docx
    const pdf = decode(result.value.pdf, "pdf", cap)
    if (!pdf.ok) return pdf
    if (typeof result.value.docxName !== "string" || typeof result.value.pdfName !== "string") {
      return { ok: false, error: SERVICE_ERROR.invalid_output }
    }
    return {
      ok: true,
      value: {
        docx: docx.value,
        pdf: pdf.value,
        docxName: result.value.docxName,
        pdfName: result.value.pdfName,
      },
    }
  }

  async function convert(request: {
    document: string
    name: string
  }): Promise<DocumentsResult<ConvertResponse>> {
    const result = await post("/convert", request)
    if (!result.ok) return result
    const pdf = decode(result.value.pdf, "pdf", cap)
    if (!pdf.ok) return pdf
    if (typeof result.value.pdfName !== "string") {
      return { ok: false, error: SERVICE_ERROR.invalid_output }
    }
    return { ok: true, value: { pdf: pdf.value, pdfName: result.value.pdfName } }
  }

  return { fill, convert }
}
