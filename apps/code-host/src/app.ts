import { Hono } from "hono"
import { readTicket } from "@openchat/code-ticket"
import type { EnvConfig } from "./env"
import { basicAuthorization, clientAddress } from "./http"
import { safeNext } from "./next"
import { signInPage, wantsHtml } from "./pages"
import { proxyRequest } from "./proxy"
import type { ProxyConfig } from "./proxy"
import { TicketReplayCache } from "./replay"
import {
  CODE_SESSION_COOKIE,
  parseCookies,
  readSessionValue,
  sessionCookie,
} from "./session"

export interface AppOptions {
  config: EnvConfig
  /** Epoch milliseconds; injected by tests for ticket/session expiry. */
  now?: () => number
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Failure log; never receives a ticket, cookie or credential. */
  log?: (message: string) => void
  /** Upstream `/api/info` deadline; tests shorten it. */
  healthTimeoutMs?: number
  replay?: TicketReplayCache
}

export interface AppBindings {
  /** The socket peer from the node adapter; not a client header. */
  remoteAddress?: string
}

export type AppEnv = { Bindings: AppBindings }

const DEFAULT_HEALTH_TIMEOUT_MS = 2_000

function jsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  }
}

function pageResponse(config: EnvConfig, status: 200 | 401, reason?: string): Response {
  return new Response(signInPage(config.APP_ORIGIN, reason), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `frame-ancestors ${config.APP_ORIGIN}`,
    },
  })
}

function unauthorized(config: EnvConfig): Response {
  return new Response(JSON.stringify({ error: "code_session_required" }), {
    status: 401,
    headers: jsonHeaders(),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { config } = options
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? ((message: string) => console.warn(`[code-host] ${message}`))
  const replay = options.replay ?? new TicketReplayCache()
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS

  const settings = {
    secret: config.CODE_TICKET_SECRET,
    ttlSeconds: config.CODE_SESSION_TTL_SECONDS,
    secureCookie: config.COOKIE_SECURE,
  }
  const proxyConfig: ProxyConfig = {
    opencodeUrl: config.OPENCODE_URL,
    username: config.OPENCODE_USERNAME,
    password: config.OPENCODE_PASSWORD,
    appOrigin: config.APP_ORIGIN,
  }

  const app = new Hono<AppEnv>()

  app.get("/__auth", (c) => {
    const token = c.req.query("ticket")
    const claims = token
      ? readTicket(token, {
          secret: config.CODE_TICKET_SECRET,
          codeHost: config.CODE_HOST_ORIGIN,
          now: now(),
        })
      : null
    const accepted = claims !== null && replay.claim(claims.jti, claims.exp, now())
    if (!claims || !accepted) {
      // Log the failure, never the ticket value.
      log(`ticket rejected (${clientAddress(c.req.raw, c.env?.remoteAddress, config.TRUST_PROXY)})`)
      return pageResponse(config, 401, "This sign-in link is invalid or has expired.")
    }

    const next = safeNext(c.req.query("next"))
    return new Response(null, {
      status: 302,
      headers: {
        location: next,
        "set-cookie": sessionCookie(settings, claims.sub, now()),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    })
  })

  app.get("/__health", async (c) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs)
    try {
      const response = await fetchImpl(`${config.OPENCODE_URL}/api/info`, {
        headers: {
          authorization: basicAuthorization(config.OPENCODE_USERNAME, config.OPENCODE_PASSWORD),
          accept: "application/json",
          "accept-encoding": "identity",
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        log("health check failed")
        return c.json({ ok: false }, 502, { "cache-control": "no-store" })
      }
      const payload: unknown = await response.json().catch(() => null)
      const version = isRecord(payload) && typeof payload.version === "string" ? payload.version : null
      if (!version) {
        log("health check failed")
        return c.json({ ok: false }, 502, { "cache-control": "no-store" })
      }
      return c.json({ ok: true, version }, 200, { "cache-control": "no-store" })
    } catch {
      log("health check failed")
      return c.json({ ok: false }, 502, { "cache-control": "no-store" })
    } finally {
      clearTimeout(timer)
    }
  })

  app.get("/__sign-in", (c) => pageResponse(config, 200))

  // Everything else, `/api/*` included, needs the Code session cookie. The
  // ticket exchange above is the only way to obtain one.
  app.all("*", async (c) => {
    const cookies = parseCookies(c.req.header("cookie") ?? null)
    const sub = readSessionValue(cookies[CODE_SESSION_COOKIE], settings, now())
    if (!sub) {
      if (!wantsHtml(c.req.raw)) return unauthorized(config)
      return pageResponse(config, 401)
    }
    return proxyRequest(c.req.raw, { config: proxyConfig, fetchImpl, log })
  })

  return app
}
