import type { Context } from "hono"
import type { Hono } from "hono"
import { authenticate, deriveSigningKey } from "./auth"
import type { AuthSettings } from "./auth"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import { jsonError, payloadTooLarge } from "./http"
import { ARTIFACT_BODY_MAX_BYTES, MAX_BODY_BYTES } from "./limits"
import type { FixedWindowThrottle } from "./throttle"
import { TRANSCRIBE_PATH } from "./transcribe"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const LOGIN_PATH = "/api/auth/login"
const LOGOUT_PATH = "/api/auth/logout"
const ARTIFACTS_PATH = "/api/artifacts"

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
  // Logout has no body; transcribe carries raw audio and enforces the
  // dictation cap itself.
  return c.req.path !== LOGOUT_PATH && c.req.path !== TRANSCRIBE_PATH
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

/** Caps a header-derived key so a huge header cannot grow the throttle map. */
const MAX_ADDRESS_LENGTH = 128

function trimmedHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Last non-empty `X-Forwarded-For` entry. nginx (`$proxy_add_x_forwarded_for`)
 * and Traefik *append* the hop they observed, so the rightmost entry is the one
 * the trusted proxy added; everything to its left was supplied by the client.
 */
function lastForwardedEntry(header: string | undefined): string | undefined {
  if (!header) return undefined
  const entries = header.split(",")
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]?.trim()
    if (entry) return entry
  }
  return undefined
}

/**
 * Declared-body cap per path. An artifact document may be 1 MiB, far above the
 * generic JSON cap, so that one route gets its own ceiling; the route enforces
 * the document limit itself. Dictation uploads are capped by
 * `DICTATION_MAX_BYTES` inside the route, which streams and aborts at the cap.
 */
function bodyCap(pathname: string): number {
  if (pathname === TRANSCRIBE_PATH) return Number.POSITIVE_INFINITY
  if (pathname === ARTIFACTS_PATH) return ARTIFACT_BODY_MAX_BYTES
  return MAX_BODY_BYTES
}

/**
 * Per-client bucket key. The socket address comes from the node adapter; the
 * forwarding headers are client-controlled, so they are only read when the
 * operator explicitly sets `TRUST_PROXY=1`. The deployment must run exactly one
 * reverse proxy and that proxy must append to `X-Forwarded-For`; the last entry
 * is then the only hop the client could not forge. `X-Real-IP` is the fallback
 * for a proxy that sets only that header. See
 * `docs/implementation/11-proxy-addressing.md`.
 */
export function clientAddress(c: Context<AppEnv>, trustProxy: boolean): string {
  let address: string | undefined
  if (trustProxy) {
    address =
      lastForwardedEntry(c.req.header("x-forwarded-for")) ??
      trimmedHeader(c.req.header("x-real-ip"))
  }
  // Never return an empty string, and never let a header grow the throttle map.
  return (address ?? c.env?.remoteAddress ?? "").slice(0, MAX_ADDRESS_LENGTH) || "local"
}

export function authSettings(config: EnvConfig): AuthSettings {
  const settings: Omit<AuthSettings, "signingKey"> = {
    mode: config.AUTH_MODE,
    user: config.OPENCHAT_USER,
    password: config.OPENCHAT_PASSWORD,
    passwordHash: config.OPENCHAT_PASSWORD_HASH,
    secret: config.SESSION_SECRET,
    ttlSeconds: config.SESSION_TTL_SECONDS,
    secureCookie: config.COOKIE_SECURE,
  }
  // Derived here, once per boot: bcrypt stays off the session-read path.
  return { ...settings, signingKey: deriveSigningKey(settings) }
}

/**
 * Runs before authentication so oversized or cross-origin requests never
 * reach a route handler.
 */
export function registerRequestGuards(app: Hono<AppEnv>): void {
  app.use("/api/*", async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && isCrossOrigin(c)) {
      return jsonError(c, 403, "cross_origin", "Cross-origin request rejected")
    }
    if (isJsonEndpoint(c) && !hasJsonContentType(c)) {
      return jsonError(c, 415, "unsupported_media_type", "Content-Type must be application/json")
    }
    const declared = declaredContentLength(c)
    if (declared !== undefined && declared > bodyCap(c.req.path)) {
      return payloadTooLarge(c, bodyCap(c.req.path))
    }
    await next()
  })
}

export interface AuthGuardDeps {
  config: EnvConfig
  loginThrottle: FixedWindowThrottle
}

/**
 * `AUTH_MODE=basic` is kept for scripted deployments (a cron job or a health
 * probe that can send an `Authorization` header); production runs session mode.
 * Basic verifies the header on every `/api/*` request, so it shares the login
 * budget: otherwise any route would be an unthrottled credential oracle.
 */
export function registerAuthentication(
  app: Hono<AppEnv>,
  settings: AuthSettings,
  deps: AuthGuardDeps,
): void {
  const { config, loginThrottle } = deps
  app.use("/api/*", async (c, next) => {
    if (c.req.path === LOGIN_PATH) {
      await next()
      return
    }

    let address: string | undefined
    if (settings.mode === "basic") {
      address = clientAddress(c, config.TRUST_PROXY)
      const throttle = loginThrottle.check(address)
      if (throttle.limited) {
        c.header("Retry-After", String(throttle.retryAfterSeconds))
        return jsonError(c, 429, "too_many_requests", "Too many failed login attempts")
      }
    }

    const user = authenticate(c.req.raw, settings)
    if (!user) {
      if (address !== undefined) loginThrottle.record(address)
      if (settings.mode === "basic") {
        c.header("WWW-Authenticate", 'Basic realm="OpenChat"')
      }
      return jsonError(c, 401, "unauthorized", "Authentication required")
    }
    if (address !== undefined) loginThrottle.reset(address)
    c.set("user", user)
    await next()
  })
}
