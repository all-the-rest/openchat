import type { Hono } from "hono"
import type { ChatBackend } from "@openchat/opencode"
import { FakeHostSwitch, SUPPORTED_OPENCODE_MAJOR_LABEL } from "@openchat/opencode"
import {
  createSessionRequestSchema,
  loginRequestSchema,
  promptRequestSchema,
} from "@openchat/contracts"
import type {
  AppsSurfaceInfo,
  CodeSurfaceInfo,
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
  verifyCredentials,
} from "./auth"
import type { AuthSettings, CredentialVerifier } from "./auth"
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
import { registerCatalogRoutes, registerPermissionRoutes } from "./completion-routes"
import { registerAppsRoutes } from "./apps"
import { AppsCache, probeApps } from "./apps-cache"
import type { AppsProbe } from "./apps-cache"
import { artifactsSurface, registerArtifactsRoutes } from "./artifacts"
import { registerArtifactInternalRoute } from "./artifacts-internal"
import { registerChatFilesRoutes } from "./chat-files"
import { registerCodeRoutes } from "./code"
import type { CodeProbe } from "./code"
import { registerSearchRoute } from "./search"
import { registerFakeControlsRoutes } from "./fake-controls"
import { registerFakeHostRoute } from "./fake-host-route"
import type { FixedWindowThrottle, VerificationGate } from "./throttle"
import { SSE_RETRY_FRAME } from "./sse"
import { registerTranscribeRoute } from "./transcribe"

/** Fixed `Retry-After` for a login rejected by the concurrency gate. */
export const LOGIN_BUSY_RETRY_AFTER_SECONDS = 1

export interface RouteDeps {
  config: EnvConfig
  backend: ChatBackend
  settings: AuthSettings
  loginThrottle: FixedWindowThrottle
  /** Caps concurrent bcrypt rounds; shared by every login request. */
  verificationGate: VerificationGate
  /** Injected by tests to hold a verification open; defaults to bcrypt. */
  verify?: CredentialVerifier
  promptThrottle: FixedWindowThrottle
  /** Upstream STT deadline; injectable so tests need not wait 30 s. */
  sttTimeoutMs: number
  /** SSE keepalive interval; injectable so tests need not wait 15 s. */
  sseHeartbeatMs: number
  /** Ticket mint throttle, per client address. */
  codeTicketThrottle: FixedWindowThrottle
  codeProbe?: CodeProbe
  codeStatusCacheMs?: number
  codeNow?: () => number
  /** Connect/disconnect throttle, per client address. */
  appsActionThrottle: FixedWindowThrottle
  /** Injected for tests; the default reads `backend.listApps`. */
  appsProbe?: AppsProbe
  /** Pre-built cache, shared by `/api/apps` and `/api/info`. */
  appsCache?: AppsCache
  /** App snapshot cache lifetime; injectable so tests need not wait 10 s. */
  appsCacheMs?: number
  /** Injected clock for the app snapshot cache. */
  appsNow?: () => number
  /** Artifact creation throttle, per client address. */
  artifactsThrottle: FixedWindowThrottle
  /** Injected clock for signed artifact URLs. */
  artifactsNow?: () => number
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
  const { config, settings, loginThrottle, verificationGate } = deps
  const verify = deps.verify ?? verifyCredentials

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

    // Every attempt is counted before the password check, so a parallel burst
    // cannot all reach bcrypt while the budget still reads empty. A success
    // resets the bucket, exactly as before: a successful attempt therefore does
    // not stay counted for the rest of the window, it clears the failures in
    // front of it. An address that never succeeds is blocked on the attempt
    // after its tenth inside the window, whether that attempt was cheap or not.
    loginThrottle.record(address)
    if (!verificationGate.tryAcquire()) {
      c.header("Retry-After", String(LOGIN_BUSY_RETRY_AFTER_SECONDS))
      return jsonError(c, 429, "server_busy", "Too many concurrent login attempts")
    }

    let user: string | null
    try {
      user = await verify(parsed.data.user, parsed.data.password, settings)
    } finally {
      // Also runs when bcrypt throws on a malformed hash, so a bad row in the
      // environment cannot wedge the gate shut.
      verificationGate.release()
    }
    if (!user) {
      return jsonError(c, 401, "invalid_credentials", "Invalid user or password")
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

function registerInfoRoutes(app: Hono<AppEnv>, deps: RouteDeps, appsCache: AppsCache): void {
  const { config, backend } = deps

  app.get("/api/info", async (c) => {
    // The host may be unreachable (a dead tunnel is a normal operating state),
    // so the three host calls settle independently: one answer proves the host
    // is up, and a failed fragment degrades instead of failing the page load.
    const appsProbe = probeApps(appsCache)
    const [info, models, agents] = await Promise.allSettled([
      backend.info(),
      backend.listModels(),
      backend.listAgents(),
    ])
    const appsAvailable = await appsProbe

    const hostReachable =
      info.status === "fulfilled" ||
      models.status === "fulfilled" ||
      agents.status === "fulfilled"

    c.header("Cache-Control", "no-store")
    return c.json({
      host: { reachable: hostReachable },
      server: info.status === "fulfilled" ? info.value : null,
      models: models.status === "fulfilled" ? models.value : [],
      agents: agents.status === "fulfilled" ? agents.value : [],
      scenario: config.BACKEND_MODE === "fake" ? config.FAKE_SCENARIO : "live",
      dictation: {
        enabled: Boolean(config.STT_URL),
        maxSeconds: config.DICTATION_MAX_SECONDS,
        maxBytes: config.DICTATION_MAX_BYTES,
      } satisfies DictationInfo,
      code: {
        configured: Boolean(config.CODE_HOST_ORIGIN),
        expectedVersion: SUPPORTED_OPENCODE_MAJOR_LABEL,
      } satisfies CodeSurfaceInfo,
      apps: { available: appsAvailable } satisfies AppsSurfaceInfo,
      artifacts: artifactsSurface(config),
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
      model: parsed.data.model,
      agent: parsed.data.agent,
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
  // One cache for both `/api/apps` and `/api/info`: a page load probes once.
  const appsCache =
    deps.appsCache ??
    new AppsCache({
      probe: deps.appsProbe ?? (() => deps.backend.listApps()),
      ttlMs: deps.appsCacheMs,
      now: deps.appsNow,
    })

  registerAuthRoutes(app, deps)
  registerInfoRoutes(app, deps, appsCache)
  registerCatalogRoutes(app, deps.backend)
  registerSessionRoutes(app, deps)
  registerPermissionRoutes(app, deps.backend)
  registerCodeRoutes(app, {
    config: deps.config,
    ticketThrottle: deps.codeTicketThrottle,
    probe: deps.codeProbe,
    statusCacheMs: deps.codeStatusCacheMs,
    now: deps.codeNow,
  })
  registerAppsRoutes(app, {
    backend: deps.backend,
    cache: appsCache,
    config: deps.config,
    actionThrottle: deps.appsActionThrottle,
  })
  registerArtifactsRoutes(app, {
    config: deps.config,
    createThrottle: deps.artifactsThrottle,
    now: deps.artifactsNow,
  })
  registerArtifactInternalRoute(app, {
    config: deps.config,
    now: deps.artifactsNow,
  })
  registerChatFilesRoutes(app, deps.config)
  registerSearchRoute(app, deps.backend)
  registerTranscribeRoute(app, deps)
  registerEventRoute(app, deps)
  // Fake mode only; the live adapter has no outage switch to expose.
  if (deps.config.BACKEND_MODE === "fake") {
    if (deps.backend instanceof FakeHostSwitch) registerFakeHostRoute(app, deps.backend)
    registerFakeControlsRoutes(app, deps.backend)
  }
}
