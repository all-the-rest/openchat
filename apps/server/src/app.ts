import { Hono } from "hono"
import type { Context } from "hono"
import { BackendError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import {
  createSessionRequestSchema,
  loginRequestSchema,
  promptRequestSchema,
} from "@openchat/contracts"
import type {
  InfoResponse,
  InboxResponse,
  LoginResponse,
  PromptResponse,
  SessionInfo,
} from "@openchat/contracts"
import {
  authenticate,
  clearSessionCookie,
  sessionCookie,
  verifyPassword,
} from "./auth"
import type { AuthSettings } from "./auth"
import type { EnvConfig } from "./env"
import { MAX_BODY_BYTES, isBodyTooLarge } from "./limits"
import { FixedWindowThrottle } from "./throttle"

export const SERVER_VERSION = "0.1.0"

/** Per-address prompt budget: 30 accepted prompts in a rolling 60 s window. */
export const PROMPT_LIMIT = 30
export const PROMPT_WINDOW_MS = 60_000

export interface AppOptions {
  config: EnvConfig
  backend: ChatBackend
  version?: string
}

export interface AppVariables {
  user: string
}

/**
 * Values the node adapter passes per request. `remoteAddress` is the socket
 * peer, not a client header, so it cannot be spoofed.
 */
export interface AppBindings {
  remoteAddress?: string
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }

function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 500,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status)
}

const INVALID_JSON = Symbol("invalid-json")
const BODY_TOO_LARGE = Symbol("body-too-large")

function payloadTooLarge(c: Context): Response {
  return jsonError(
    c,
    413,
    "payload_too_large",
    `Request body must not exceed ${MAX_BODY_BYTES} bytes`,
  )
}

async function readJson(c: Context): Promise<unknown> {
  const buffer = await c.req.arrayBuffer()
  if (isBodyTooLarge(buffer)) return BODY_TOO_LARGE
  const text = new TextDecoder().decode(buffer)
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return INVALID_JSON
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const LOGOUT_PATH = "/api/auth/logout"

function requestHost(c: Context): string | undefined {
  const header = c.req.header("host")?.trim()
  if (header) return header.toLowerCase()
  try {
    return new URL(c.req.url).host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Rejects state-changing requests that a browser marks as cross-origin.
 * `Origin` is compared on host and port only, so a TLS-terminating dev proxy
 * may change the scheme. Requests without both headers (curl, tests, native
 * clients) are allowed and rely on the session cookie or basic auth.
 */
function isCrossOrigin(c: Context): boolean {
  const origin = c.req.header("origin")
  if (origin !== undefined) {
    let originHost: string | undefined
    try {
      originHost = new URL(origin).host.toLowerCase()
    } catch {
      originHost = undefined
    }
    const host = requestHost(c)
    if (!originHost || !host || originHost !== host) return true
  }

  const site = c.req.header("sec-fetch-site")?.trim().toLowerCase()
  if (site !== undefined && site !== "same-origin" && site !== "none") return true

  return false
}

function isJsonEndpoint(c: Context): boolean {
  if (SAFE_METHODS.has(c.req.method)) return false
  if (!c.req.path.startsWith("/api/")) return false
  return c.req.path !== LOGOUT_PATH
}

function hasJsonContentType(c: Context): boolean {
  const type = c.req.header("content-type") ?? ""
  return type.split(";")[0]?.trim().toLowerCase() === "application/json"
}

function declaredContentLength(c: Context): number | undefined {
  const header = c.req.header("content-length")
  if (!header) return undefined
  const value = Number(header)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Per-client bucket key. The socket address comes from the node adapter; the
 * forwarding headers are client-controlled, so they are only read when the
 * operator explicitly sets `TRUST_PROXY=1` (the BFF sits behind a reverse proxy
 * that overwrites them).
 */
function clientAddress(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded) return forwarded
    const real = c.req.header("x-real-ip")?.trim()
    if (real) return real
  }
  return c.env?.remoteAddress || "local"
}

function invalidMessage(error: { issues: Array<{ message?: string }> }): string {
  return error.issues[0]?.message ?? "Invalid request body"
}

function authSettings(config: EnvConfig): AuthSettings {
  return {
    mode: config.AUTH_MODE,
    user: config.OPENCHAT_USER,
    password: config.OPENCHAT_PASSWORD,
    secret: config.SESSION_SECRET,
    ttlSeconds: config.SESSION_TTL_SECONDS,
    secureCookie: config.COOKIE_SECURE,
  }
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

const SSE_HEARTBEAT_MS = 15_000

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { config, backend } = options
  const version = options.version ?? SERVER_VERSION
  const settings = authSettings(config)
  const loginThrottle = new FixedWindowThrottle()
  const promptThrottle = new FixedWindowThrottle({
    limit: PROMPT_LIMIT,
    windowMs: PROMPT_WINDOW_MS,
  })
  const app = new Hono<AppEnv>()

  app.onError((error, c) => {
    if (error instanceof BackendError) {
      const status = error.code === "not_found" ? 404 : 400
      return jsonError(c, status, error.code, error.message)
    }
    return jsonError(c, 500, "internal_error", "Unexpected server error")
  })

  app.get("/healthz", (c) =>
    c.json({ ok: true, mode: config.BACKEND_MODE, version }),
  )

  // Runs before authentication so oversized or cross-origin requests never
  // reach a route handler.
  app.use("/api/*", async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && isCrossOrigin(c)) {
      return jsonError(c, 403, "cross_origin", "Cross-origin request rejected")
    }
    if (isJsonEndpoint(c) && !hasJsonContentType(c)) {
      return jsonError(c, 415, "unsupported_media_type", "Content-Type must be application/json")
    }
    const declared = declaredContentLength(c)
    if (declared !== undefined && declared > MAX_BODY_BYTES) {
      return payloadTooLarge(c)
    }
    await next()
  })

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/login") {
      await next()
      return
    }
    const user = authenticate(c.req.raw, settings)
    if (!user) {
      if (settings.mode === "basic") {
        c.header("WWW-Authenticate", 'Basic realm="OpenChat"')
      }
      return jsonError(c, 401, "unauthorized", "Authentication required")
    }
    c.set("user", user)
    await next()
  })

  app.post("/api/auth/login", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = loginRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }

    const address = clientAddress(c, config.TRUST_PROXY)
    const throttle = loginThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", "Too many failed login attempts")
    }

    const user = verifyPassword(parsed.data.password, settings)
    if (!user) {
      loginThrottle.record(address)
      return jsonError(c, 401, "invalid_credentials", "Invalid password")
    }
    loginThrottle.reset(address)
    if (config.AUTH_MODE === "session") {
      c.header("Set-Cookie", sessionCookie(settings))
    }
    return c.json({ user } satisfies LoginResponse)
  })

  app.get("/api/auth/me", (c) =>
    c.json({ user: c.get("user") } satisfies LoginResponse),
  )

  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", clearSessionCookie(settings))
    return c.body(null, 204)
  })

  app.get("/api/info", async (c) => {
    const [server, models, agents] = await Promise.all([
      backend.info(),
      backend.listModels(),
      backend.listAgents(),
    ])
    return c.json({
      server,
      models,
      agents,
      scenario: config.BACKEND_MODE === "fake" ? config.FAKE_SCENARIO : "live",
    } satisfies InfoResponse)
  })

  app.get("/api/sessions", async (c) => {
    const sessions = await backend.listSessions()
    return c.json(sessions)
  })

  app.post("/api/sessions", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = createSessionRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    const session = await backend.createSession({
      title: parsed.data.title,
      directory: config.WORKSPACE_DIR,
    })
    return c.json(session satisfies SessionInfo)
  })

  app.get("/api/sessions/:id/messages", async (c) => {
    return c.json(await backend.listMessages(c.req.param("id")))
  })

  app.post("/api/sessions/:id/prompt", async (c) => {
    const address = clientAddress(c, config.TRUST_PROXY)
    const throttle = promptThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", "Too many prompts")
    }

    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = promptRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    // Count accepted submissions only; a rejected body must not consume the
    // caller's budget.
    promptThrottle.record(address)
    // Spec 03: one active run per session. A second send is queued rather than
    // rejected, so the BFF defaults to the queue delivery mode.
    const result = await backend.prompt(c.req.param("id"), {
      text: parsed.data.text,
      delivery: parsed.data.delivery ?? "queue",
    })
    const response: PromptResponse = { ok: true, messageID: result.messageID }
    if (result.queued) response.queued = true
    return c.json(response)
  })

  app.get("/api/sessions/:id/inbox", async (c) => {
    const entries = await backend.listInbox(c.req.param("id"))
    return c.json({ entries } satisfies InboxResponse)
  })

  // DELETE is state-changing, so the existing JSON content-type rule applies;
  // clients send `Content-Type: application/json` even though the body is empty.
  app.delete("/api/sessions/:id/inbox/:messageID", async (c) => {
    await backend.cancelQueued(c.req.param("id"), c.req.param("messageID"))
    return c.json({ ok: true })
  })

  app.post("/api/sessions/:id/interrupt", async (c) => {
    await backend.interrupt(c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/api/events", (c) => {
    const lifecycle = new AbortController()
    const encoder = new TextEncoder()
    const subscription = backend.subscribe(lifecycle.signal)
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let finished = false

    const cleanup = () => {
      if (finished) return
      finished = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      lifecycle.abort()
    }

    const onAbort = () => cleanup()
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })
    if (c.req.raw.signal.aborted) cleanup()

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          controller.enqueue(encoder.encode(chunk))
        }
        const pump = async () => {
          try {
            write("retry: 2000\n\n")
            heartbeat = setInterval(() => {
              try {
                write(": heartbeat\n\n")
              } catch {
                cleanup()
              }
            }, SSE_HEARTBEAT_MS)
            for await (const event of subscription) {
              write(`data: ${JSON.stringify(event)}\n\n`)
            }
          } catch {
            // The client went away or the backend stopped; closing is enough.
          } finally {
            cleanup()
            c.req.raw.signal.removeEventListener("abort", onAbort)
            try {
              controller.close()
            } catch {
              // Already closed by the consumer.
            }
          }
        }
        void pump()
      },
      cancel() {
        cleanup()
      },
    })

    return new Response(body, { headers: sseHeaders() })
  })

  return app
}
