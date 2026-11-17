import type { Context } from "hono"
import type { Hono } from "hono"
import { authenticate } from "./auth"
import type { AuthSettings } from "./auth"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import { jsonError, payloadTooLarge } from "./http"
import { MAX_BODY_BYTES } from "./limits"

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
export function clientAddress(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded) return forwarded
    const real = c.req.header("x-real-ip")?.trim()
    if (real) return real
  }
  return c.env?.remoteAddress || "local"
}

export function authSettings(config: EnvConfig): AuthSettings {
  return {
    mode: config.AUTH_MODE,
    user: config.OPENCHAT_USER,
    password: config.OPENCHAT_PASSWORD,
    secret: config.SESSION_SECRET,
    ttlSeconds: config.SESSION_TTL_SECONDS,
    secureCookie: config.COOKIE_SECURE,
  }
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
    if (declared !== undefined && declared > MAX_BODY_BYTES) {
      return payloadTooLarge(c)
    }
    await next()
  })
}

export function registerAuthentication(
  app: Hono<AppEnv>,
  settings: AuthSettings,
): void {
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
}
