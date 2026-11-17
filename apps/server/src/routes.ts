import type { Hono } from "hono"
import type { ChatBackend } from "@openchat/opencode"
import {
  createSessionRequestSchema,
  loginRequestSchema,
  promptRequestSchema,
} from "@openchat/contracts"
import type {
  DictationInfo,
  InfoResponse,
  InboxResponse,
  LoginResponse,
  PromptResponse,
  SessionInfo,
} from "@openchat/contracts"
import {
  clearSessionCookie,
  sessionCookie,
  verifyPassword,
} from "./auth"
import type { AuthSettings } from "./auth"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"
import { clientAddress } from "./middleware"
import { registerSearchRoute } from "./search"
import type { FixedWindowThrottle } from "./throttle"
import { SSE_RETRY_FRAME } from "./sse"
import { registerTranscribeRoute } from "./transcribe"

export interface RouteDeps {
  config: EnvConfig
  backend: ChatBackend
  settings: AuthSettings
  loginThrottle: FixedWindowThrottle
  promptThrottle: FixedWindowThrottle
  /** Upstream STT deadline; injectable so tests need not wait 30 s. */
  sttTimeoutMs: number
  /** SSE keepalive interval; injectable so tests need not wait 15 s. */
  sseHeartbeatMs: number
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

function registerAuthRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { config, settings, loginThrottle } = deps

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
}

function registerInfoRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { config, backend } = deps

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
      dictation: {
        enabled: Boolean(config.STT_URL),
        maxSeconds: config.DICTATION_MAX_SECONDS,
        maxBytes: config.DICTATION_MAX_BYTES,
      } satisfies DictationInfo,
    } satisfies InfoResponse)
  })
}

function registerSessionRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { config, backend, promptThrottle } = deps

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
}

function registerEventRoute(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { backend, sseHeartbeatMs } = deps

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
            write(`${SSE_RETRY_FRAME}\n\n`)
            heartbeat = setInterval(() => {
              try {
                write(": heartbeat\n\n")
              } catch {
                cleanup()
              }
            }, sseHeartbeatMs)
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
}

/** Registers every API route; the guards and authentication run before it. */
export function registerRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  registerAuthRoutes(app, deps)
  registerInfoRoutes(app, deps)
  registerSessionRoutes(app, deps)
  registerSearchRoute(app, deps.backend)
  registerTranscribeRoute(app, deps)
  registerEventRoute(app, deps)
}
