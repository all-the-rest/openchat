import type {
  AppsResponse,
  ArtifactResponse,
  ChatFilesResponse,
  CodeStatusResponse,
  CodeTicketResponse,
  CreateSessionRequest,
  InboxEntry,
  InfoResponse,
  LoginResponse,
  Message,
  AgentInfo,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  PromptRequest,
  PromptResponse,
  SearchResponse,
  SearchSource,
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

/** Server names come from the host, so they are encoded like any path segment. */
const appPath = (name: string) => `/api/apps/${encodeURIComponent(name)}`

const artifactPath = (id: string) => `/api/artifacts/${encodeURIComponent(id)}`

/**
 * Raw bytes for a download. The app origin serves them, never the signed
 * artifact host, so no short-lived URL reaches the browser's download history.
 */
async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "text/html" },
  })
  if (!response.ok) throw await parseError(response)
  return response.blob()
}

export const api = {
  me(): Promise<LoginResponse> {
    return request<LoginResponse>("/api/auth/me")
  },

  login(user: string, password: string): Promise<LoginResponse> {
    return request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ user, password }),
    })
  },

  logout(): Promise<void> {
    return request<void>("/api/auth/logout", { method: "POST" })
  },

  info(): Promise<InfoResponse> {
    return request<InfoResponse>("/api/info")
  },

  /** Chat model catalogue; an empty list means the picker stays hidden. */
  async models(): Promise<ModelInfo[]> {
    const body = await request<unknown>("/api/models")
    return unwrapList<ModelInfo>(body, "models")
  },

  /** Agent catalogue; an empty list means the picker stays hidden. */
  async agents(): Promise<AgentInfo[]> {
    const body = await request<unknown>("/api/agents")
    return unwrapList<AgentInfo>(body, "agents")
  },

  /**
   * Mints a single-use Code-host entry URL. `next` is a path on the Code host;
   * the BFF sanitises it and the Code host validates it again.
   */
  codeTicket(next: string): Promise<CodeTicketResponse> {
    const params = new URLSearchParams({ next })
    return request<CodeTicketResponse>(`/api/code/ticket?${params.toString()}`)
  },

  codeStatus(): Promise<CodeStatusResponse> {
    return request<CodeStatusResponse>("/api/code/status")
  },

  /** The workspace's MCP servers and skills, plus the capability flag. */
  apps(): Promise<AppsResponse> {
    return request<AppsResponse>("/api/apps")
  },

  /** Asks the host to connect a server; the BFF replies with 204 and no body. */
  connectApp(name: string): Promise<void> {
    return request<void>(`${appPath(name)}/connect`, {
      method: "POST",
      body: JSON.stringify({}),
    })
  },

  /** Asks the host to disconnect a server; the BFF replies with 204 and no body. */
  disconnectApp(name: string): Promise<void> {
    return request<void>(`${appPath(name)}/disconnect`, {
      method: "POST",
      body: JSON.stringify({}),
    })
  },

  /** Newest-first artifact metadata with a URL signed by the BFF at this read. */
  async artifacts(): Promise<ArtifactResponse[]> {
    const body = await request<unknown>("/api/artifacts")
    return unwrapList<ArtifactResponse>(body, "artifacts")
  },

  /** One artifact plus a freshly minted signed URL; never built client-side. */
  artifact(id: string): Promise<ArtifactResponse> {
    return request<ArtifactResponse>(artifactPath(id))
  },

  /** The exact stored document, through the BFF rather than the host URL. */
  artifactDownload(id: string): Promise<Blob> {
    return requestBlob(`${artifactPath(id)}/download`)
  },

  /** One chat's working files plus the current quota fill levels. */
  chatFiles(sessionID: string): Promise<ChatFilesResponse> {
    return request<ChatFilesResponse>(`${sessionPath(sessionID)}/files`)
  },

  /**
   * Same-origin URL for a chat file. The BFF answers with an attachment, so a
   * plain link downloads the bytes without a script-built blob.
   */
  chatFileDownloadUrl(sessionID: string, name: string): string {
    return `${sessionPath(sessionID)}/files/${encodeURIComponent(name)}`
  },

  deleteChatFile(sessionID: string, name: string): Promise<void> {
    return request<void>(`${sessionPath(sessionID)}/files/${encodeURIComponent(name)}`, {
      method: "DELETE",
      // The BFF requires a JSON content type on state-changing requests.
      body: JSON.stringify({}),
    })
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

  /** Pending turns of a session; a reload restores the queued markers. */
  async listInbox(sessionID: string): Promise<InboxEntry[]> {
    const body = await request<unknown>(`${sessionPath(sessionID)}/inbox`)
    return unwrapList<InboxEntry>(body, "entries")
  },

  /** Drops one pending turn by the message id the prompt response returned. */
  cancelQueued(sessionID: string, messageID: string): Promise<void> {
    return request<void>(`${sessionPath(sessionID)}/inbox/${encodeURIComponent(messageID)}`, {
      method: "DELETE",
      // The BFF requires a JSON content type on state-changing requests.
      body: JSON.stringify({}),
    })
  },

  /** One grouped query; `sources` limits what the BFF is allowed to query. */
  search(input: {
    query: string
    sources: readonly SearchSource[]
    limit?: number
    signal?: AbortSignal
  }): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: input.query, sources: input.sources.join(",") })
    if (input.limit !== undefined) params.set("limit", String(input.limit))
    return request<SearchResponse>(`/api/search?${params.toString()}`, {
      signal: input.signal,
    })
  },

  prompt(sessionID: string, input: PromptRequest): Promise<PromptResponse> {
    return request<PromptResponse>(`${sessionPath(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  /** Outstanding tool approvals of one session. */
  async listPermissions(sessionID: string): Promise<PermissionRequest[]> {
    const body = await request<unknown>(`${sessionPath(sessionID)}/permissions`)
    return unwrapList<PermissionRequest>(body, "requests")
  },

  replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void> {
    return request<void>(
      `${sessionPath(sessionID)}/permissions/${encodeURIComponent(requestID)}`,
      { method: "POST", body: JSON.stringify({ decision }) },
    )
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
