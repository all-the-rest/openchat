import type {
  CreateSessionRequest,
  InfoResponse,
  LoginResponse,
  Message,
  PromptRequest,
  PromptResponse,
  SessionInfo,
  TranscriptionResponse,
} from "@openchat/contracts"

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

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }
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
  return new ApiError(response.status, message, code)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  headers.set("accept", "application/json")

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  })

  if (!response.ok) throw await parseError(response)
  if (response.status === 204) return undefined as T

  const text = await response.text()
  if (text.length === 0) return undefined as T
  return JSON.parse(text) as T
}

/**
 * The BFF returns bare arrays for list endpoints. Accepting a wrapped key as
 * well keeps the client working while the server surface settles.
 */
function unwrapList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value !== null && typeof value === "object") {
    const candidate = (value as Record<string, unknown>)[key]
    if (Array.isArray(candidate)) return candidate as T[]
  }
  return []
}

const sessionPath = (sessionID: string) => `/api/sessions/${encodeURIComponent(sessionID)}`

export const api = {
  me(): Promise<LoginResponse> {
    return request<LoginResponse>("/api/auth/me")
  },

  login(password: string): Promise<LoginResponse> {
    return request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    })
  },

  logout(): Promise<void> {
    return request<void>("/api/auth/logout", { method: "POST" })
  },

  info(): Promise<InfoResponse> {
    return request<InfoResponse>("/api/info")
  },

  async listSessions(): Promise<SessionInfo[]> {
    const body = await request<unknown>("/api/sessions")
    return unwrapList<SessionInfo>(body, "sessions")
  },

  createSession(input: CreateSessionRequest = {}): Promise<SessionInfo> {
    return request<SessionInfo>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  async listMessages(sessionID: string): Promise<Message[]> {
    const body = await request<unknown>(`${sessionPath(sessionID)}/messages`)
    return unwrapList<Message>(body, "messages")
  },

  prompt(sessionID: string, input: PromptRequest): Promise<PromptResponse> {
    return request<PromptResponse>(`${sessionPath(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  interrupt(sessionID: string): Promise<void> {
    return request<void>(`${sessionPath(sessionID)}/interrupt`, {
      method: "POST",
      // The BFF requires a JSON content type on state-changing requests.
      body: JSON.stringify({}),
    })
  },

  /**
   * Sends one recording to the BFF. The body is the raw audio blob; the BFF
   * accepts the base MIME type (`audio/webm`, `audio/mp4`, `audio/ogg`) and
   * rejects anything else with `415 unsupported_media_type`.
   */
  transcribe(audio: Blob, options: { language?: string } = {}): Promise<TranscriptionResponse> {
    const query = options.language ? `?language=${encodeURIComponent(options.language)}` : ""
    const mime = audio.type.split(";")[0]?.trim() || "application/octet-stream"
    return request<TranscriptionResponse>(`/api/transcribe${query}`, {
      method: "POST",
      body: audio,
      headers: { "content-type": mime },
    })
  },
}
