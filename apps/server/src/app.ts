import { Hono } from "hono"
import { BackendError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import type { CodeProbe } from "./code"
import { CODE_TICKET_LIMIT, CODE_TICKET_WINDOW_MS } from "./code"
import type { EnvConfig } from "./env"
import { jsonError } from "./http"
import {
  authSettings,
  registerAuthentication,
  registerRequestGuards,
} from "./middleware"
import { registerRoutes } from "./routes"
import { SSE_HEARTBEAT_MS } from "./sse"
import { FixedWindowThrottle } from "./throttle"
import { STT_TIMEOUT_MS } from "./transcribe"

export const SERVER_VERSION = "0.1.0"

/** Per-address prompt budget: 30 accepted prompts in a rolling 60 s window. */
export const PROMPT_LIMIT = 30
export const PROMPT_WINDOW_MS = 60_000

export interface AppOptions {
  config: EnvConfig
  backend: ChatBackend
  version?: string
  /** Upstream STT deadline in milliseconds; tests shorten it. */
  sttTimeoutMs?: number
  /** SSE keepalive interval in milliseconds; tests shorten it. */
  sseHeartbeatMs?: number
  /** Code host health probe; injected so tests never touch the network. */
  codeProbe?: CodeProbe
  /** Status cache lifetime in milliseconds; tests shorten it. */
  codeStatusCacheMs?: number
  /** Clock for the status cache; tests advance it. */
  codeNow?: () => number
  /** Ticket throttle; tests inject a clock-bound instance. */
  codeTicketThrottle?: FixedWindowThrottle
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

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { config, backend } = options
  const version = options.version ?? SERVER_VERSION
  const settings = authSettings(config)
  const loginThrottle = new FixedWindowThrottle()
  const promptThrottle = new FixedWindowThrottle({
    limit: PROMPT_LIMIT,
    windowMs: PROMPT_WINDOW_MS,
  })
  const codeTicketThrottle =
    options.codeTicketThrottle ??
    new FixedWindowThrottle({
      limit: CODE_TICKET_LIMIT,
      windowMs: CODE_TICKET_WINDOW_MS,
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

  registerRequestGuards(app)
  registerAuthentication(app, settings)
  registerRoutes(app, {
    config,
    backend,
    settings,
    loginThrottle,
    promptThrottle,
    sttTimeoutMs: options.sttTimeoutMs ?? STT_TIMEOUT_MS,
    sseHeartbeatMs: options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS,
    codeTicketThrottle,
    codeProbe: options.codeProbe,
    codeStatusCacheMs: options.codeStatusCacheMs,
    codeNow: options.codeNow,
  })

  return app
}
