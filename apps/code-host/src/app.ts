import { Hono } from "hono"
import { readTicket } from "@openchat/code-ticket"
import { refusesUnsafeRequest } from "./csrf"
import type { EnvConfig } from "./env"
import { basicAuthorization, clientAddress } from "./http"
import { safeNext } from "./next"
import { signInPage, wantsHtml } from "./pages"
import { proxyRequest } from "./proxy"
import type { ProxyConfig } from "./proxy"
import { TicketReplayCache } from "./replay"
import {
  parseCookies,
  readSessionValue,
  sessionCookie,
  sessionCookieName,
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
  /** `/__health` version-cache lifetime; tests shorten or clock it. */
  healthCacheMs?: number
  replay?: TicketReplayCache
}

export interface AppBindings {
  /** The socket peer from the node adapter; not a client header. */
  remoteAddress?: string
}

export type AppEnv = { Bindings: AppBindings }

const DEFAULT_HEALTH_TIMEOUT_MS = 2_000
/** `/__health` amplification bound: one upstream probe per window. */
const DEFAULT_HEALTH_CACHE_MS = 5_000
/** A health body is a small JSON object; anything larger is not trusted. */
const HEALTH_BODY_LIMIT_BYTES = 4_096
/** A version string is a short token; longer values are truncated. */
const HEALTH_VERSION_MAX_LENGTH = 64

type HealthBody = { ok: true; version: string } | { ok: false }

interface HealthResult {
  at: number
  status: 200 | 502
  body: HealthBody
}

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

/**
 * Local answer for a cross-origin state change. Built here so no upstream byte
 * (redirect target, challenge, error text) can reach the browser.
 */
function crossOriginForbidden(): Response {
  return new Response(JSON.stringify({ error: "cross_origin_forbidden" }), {
    status: 403,
    headers: jsonHeaders(),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Reads at most `limit` bytes of a response body. A larger body is cancelled
 * and reported as untrusted instead of being parsed; the health probe must
 * never buffer whatever upstream sends.
 */
async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  const body = response.body
  if (!body) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch {
    return null
  }
}

/**
 * A version is a short printable token. Control bytes are dropped (a hostile
 * upstream must not smuggle terminal escapes into a probe answer) and the
 * result is capped, so the endpoint never echoes an unbounded string.
 */
function printableVersion(raw: string): string | null {
  const cleaned = raw.replace(/[^\x20-\x7e]/g, "").trim()
  if (cleaned.length === 0) return null
  return cleaned.slice(0, HEALTH_VERSION_MAX_LENGTH)
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { config } = options
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? ((message: string) => console.warn(`[code-host] ${message}`))
  const replay = options.replay ?? new TicketReplayCache()
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const healthCacheMs = options.healthCacheMs ?? DEFAULT_HEALTH_CACHE_MS
  let healthCache: HealthResult | undefined

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
          // The receiver enforces the operator's lifetime, not a fixed 60 s.
          ttlSeconds: config.CODE_TICKET_TTL_SECONDS,
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
    const at = now()
    if (healthCache && at - healthCache.at < healthCacheMs) {
      return c.json(healthCache.body, healthCache.status, { "cache-control": "no-store" })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs)
    let result: Omit<HealthResult, "at">
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
        result = { status: 502, body: { ok: false } }
      } else {
        const text = await readBoundedText(response, HEALTH_BODY_LIMIT_BYTES)
        let payload: unknown = null
        if (text !== null) {
          try {
            payload = JSON.parse(text) as unknown
          } catch {
            payload = null
          }
        }
        const raw = isRecord(payload) && typeof payload.version === "string" ? payload.version : null
        const version = raw === null ? null : printableVersion(raw)
        result = version
          ? { status: 200, body: { ok: true, version } }
          : { status: 502, body: { ok: false } }
      }
    } catch {
      result = { status: 502, body: { ok: false } }
    } finally {
      clearTimeout(timer)
    }

    if (result.status !== 200) log("health check failed")
    // Failures are cached too: an unauthenticated caller must not drive one
    // upstream probe per request while the host is down or hostile.
    healthCache = { at, ...result }
    return c.json(result.body, result.status, { "cache-control": "no-store" })
  })

  app.get("/__sign-in", (c) => pageResponse(config, 200))

  // Everything else, `/api/*` included, needs the Code session cookie. The
  // ticket exchange above is the only way to obtain one. Unsafe methods must
  // carry browser same-origin evidence first: `SameSite=Lax` is site-scoped,
  // so a sibling origin on the same registrable domain would otherwise drive
  // OpenCode with the owner's session.
  app.all("*", async (c) => {
    const name = sessionCookieName(settings)
    if (refusesUnsafeRequest(c.req.raw, config.CODE_HOST_ORIGIN, name)) {
      // Never log the origin or the cookie, only the attribution.
      log(`cross-origin request rejected (${clientAddress(c.req.raw, c.env?.remoteAddress, config.TRUST_PROXY)})`)
      return crossOriginForbidden()
    }
    const cookies = parseCookies(c.req.header("cookie") ?? null)
    const sub = readSessionValue(cookies[name], settings, now())
    if (!sub) {
      if (!wantsHtml(c.req.raw)) return unauthorized(config)
      return pageResponse(config, 401)
    }
    return proxyRequest(c.req.raw, { config: proxyConfig, fetchImpl, log })
  })

  return app
}
