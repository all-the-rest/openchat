import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "oc_session"

export interface AuthSettings {
  mode: "session" | "basic"
  user: string
  password: string
  secret: string
  ttlSeconds: number
  secureCookie: boolean
}

/** Hashes both inputs to a fixed length before the constant-time compare. */
export function constantTimeEqual(left: string, right: string): boolean {
  const digestLeft = createHash("sha256").update(left).digest()
  const digestRight = createHash("sha256").update(right).digest()
  return timingSafeEqual(digestLeft, digestRight)
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

export function createSessionValue(
  settings: AuthSettings,
  now = Date.now(),
): string {
  const expires = Math.floor(now / 1000) + settings.ttlSeconds
  const payload = `${settings.user}.${expires}`
  return `${payload}.${sign(payload, settings.secret)}`
}

/** Returns the user for a valid, unexpired cookie; otherwise `null`. */
export function readSessionValue(
  value: string,
  settings: AuthSettings,
  now = Date.now(),
): string | null {
  const separator = value.lastIndexOf(".")
  if (separator <= 0) return null
  const payload = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  const expirySeparator = payload.lastIndexOf(".")
  if (expirySeparator <= 0) return null
  const user = payload.slice(0, expirySeparator)
  const expires = Number(payload.slice(expirySeparator + 1))
  if (!Number.isInteger(expires) || expires * 1000 <= now) return null
  if (!constantTimeEqual(signature, sign(payload, settings.secret))) return null
  if (!constantTimeEqual(user, settings.user)) return null
  return user
}

function cookieAttributes(settings: AuthSettings, maxAge: number): string {
  const attributes = [`Path=/`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`]
  if (settings.secureCookie) attributes.push("Secure")
  return attributes.join("; ")
}

export function sessionCookie(settings: AuthSettings, now = Date.now()): string {
  return `${SESSION_COOKIE}=${createSessionValue(settings, now)}; ${cookieAttributes(settings, settings.ttlSeconds)}`
}

export function clearSessionCookie(settings: AuthSettings): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(settings, 0)}`
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=")
    if (separator <= 0) continue
    const name = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1).trim()
    if (name) cookies[name] = value
  }
  return cookies
}

export function verifyPassword(input: string, settings: AuthSettings): string | null {
  return constantTimeEqual(input, settings.password) ? settings.user : null
}

/** Validates `Authorization: Basic base64(user:password)`. */
export function verifyBasic(
  header: string | null,
  settings: AuthSettings,
): string | null {
  if (!header) return null
  const match = /^Basic\s+(.+)$/i.exec(header.trim())
  const encoded = match?.[1]
  if (!encoded) return null
  let decoded: string
  try {
    decoded = atob(encoded)
  } catch {
    return null
  }
  return constantTimeEqual(decoded, `${settings.user}:${settings.password}`)
    ? settings.user
    : null
}

/**
 * Resolves the authenticated user for a request. Session mode reads the
 * signed cookie only; basic mode reads the Authorization header only.
 */
export function authenticate(
  request: Request,
  settings: AuthSettings,
  now = Date.now(),
): string | null {
  if (settings.mode === "basic") {
    return verifyBasic(request.headers.get("authorization"), settings)
  }
  const cookies = parseCookies(request.headers.get("cookie"))
  const value = cookies[SESSION_COOKIE]
  if (!value) return null
  return readSessionValue(value, settings, now)
}
