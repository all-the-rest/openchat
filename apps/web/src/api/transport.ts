import { reportNetworkFailure, reportNetworkSuccess } from "../pwa/offline"

export interface ApiErrorBody {
  error?: {
    code?: unknown
    message?: unknown
  }
}

/** Structured API failure, mirroring the BFF shape `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  /** Seconds from a `Retry-After` header, when the BFF sent one. */
  readonly retryAfter: number | undefined

  constructor(status: number, message: string, code?: string, retryAfter?: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

/** Only a delta-seconds `Retry-After` is meaningful for the UI. */
function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")?.trim()
  if (!header || !/^\d+$/.test(header)) return undefined
  return Number(header)
}

async function parseError(response: Response): Promise<ApiError> {
  let code: string | undefined
  let message = response.statusText || `HTTP ${response.status}`
  try {
    const body = (await response.json()) as ApiErrorBody
    if (typeof body?.error?.code === "string") code = body.error.code
    if (typeof body?.error?.message === "string") message = body.error.message
  } catch {
    // Non-JSON error bodies keep the status text.
  }
  return new ApiError(response.status, message, code, parseRetryAfter(response))
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  headers.set("accept", "application/json")

  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    })
  } catch (error) {
    reportNetworkFailure()
    throw error
  }
  reportNetworkSuccess()
  if (response.headers.get("x-openchat-offline") === "1") reportNetworkFailure()

  if (!response.ok) throw await parseError(response)
  if (response.status === 204) return undefined as T

  const text = await response.text()
  if (text.length === 0) return undefined as T
  return JSON.parse(text) as T
}

/**
 * Raw bytes for a download. The app origin serves them, never the signed
 * artifact host, so no short-lived URL reaches the browser's download history.
 */
export async function requestBlob(path: string): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "text/html" },
    })
  } catch (error) {
    reportNetworkFailure()
    throw error
  }
  reportNetworkSuccess()
  if (response.headers.get("x-openchat-offline") === "1") reportNetworkFailure()
  if (!response.ok) throw await parseError(response)
  return response.blob()
}
