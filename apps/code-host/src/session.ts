import { createHash, createHmac, timingSafeEqual } from "node:crypto"

/**
 * The Code host's own session cookie. It is host-only (no `Domain`) and lives
 * on the Code host origin, so it is never sent to the app or the artifact
 * origin. The signing key is derived from `CODE_TICKET_SECRET`, which keeps a
 * single secret in the deployment while separating ticket and cookie keys.
 *
 * With `COOKIE_SECURE` on the name carries the `__Host-` prefix: browsers then
 * refuse a cookie with a `Domain` attribute, so a sibling subdomain cannot
 * shadow it. Development keeps the plain name, and only the name matching the
 * configuration is ever read (never both).
 */
export const CODE_SESSION_COOKIE = "oc_code"
export const SECURE_CODE_SESSION_COOKIE = "__Host-oc_code"

const SESSION_VERSION = "v1"
const DERIVATION_LABEL = "openchat:code-session"

export interface SessionSettings {
  secret: string
  ttlSeconds: number
  secureCookie: boolean
}

export interface CodeSession {
  sub: string
  /** Expiry as epoch seconds. */
  exp: number
}

function constantTimeEqual(left: string, right: string): boolean {
  const digestLeft = createHash("sha256").update(left).digest()
  const digestRight = createHash("sha256").update(right).digest()
  return timingSafeEqual(digestLeft, digestRight)
}

/** The only cookie name the current configuration accepts. */
export function sessionCookieName(settings: Pick<SessionSettings, "secureCookie">): string {
  return settings.secureCookie ? SECURE_CODE_SESSION_COOKIE : CODE_SESSION_COOKIE
}

function sessionKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(DERIVATION_LABEL).digest()
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", sessionKey(secret)).update(payload).digest("base64url")
}

function encodeSession(session: CodeSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url")
}

function decodeSession(payload: string): CodeSession | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const { sub, exp } = parsed as Record<string, unknown>
  if (typeof sub !== "string" || sub.length === 0) return null
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp <= 0) return null
  return { sub, exp }
}

/** Builds the signed cookie value: `v1.<base64url(payload)>.<HMAC>`. */
export function createSessionValue(
  settings: SessionSettings,
  sub: string,
  now = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + settings.ttlSeconds
  const payload = encodeSession({ sub, exp })
  const signature = sign(`${SESSION_VERSION}.${payload}`, settings.secret)
  return `${SESSION_VERSION}.${payload}.${signature}`
}

/** Returns the subject for a valid, unexpired cookie; otherwise `null`. */
export function readSessionValue(
  value: string | undefined,
  settings: SessionSettings,
  now = Date.now(),
): string | null {
  try {
    if (!value) return null
    const parts = value.split(".")
    if (parts.length !== 3) return null
    const [version, payload, signature] = parts
    if (version !== SESSION_VERSION || !payload || !signature) return null
    const expected = sign(`${version}.${payload}`, settings.secret)
    if (!constantTimeEqual(signature, expected)) return null
    const session = decodeSession(payload)
    if (!session) return null
    if (session.exp <= Math.floor(now / 1000)) return null
    return session.sub
  } catch {
    return null
  }
}

/**
 * Cookie attributes are fixed on purpose: host-only (never `Domain`), not
 * readable from script, and Lax so the top-level ticket redirect sends it.
 */
function cookieAttributes(settings: SessionSettings): string {
  const attributes = [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${settings.ttlSeconds}`,
  ]
  if (settings.secureCookie) attributes.push("Secure")
  return attributes.join("; ")
}

export function sessionCookie(
  settings: SessionSettings,
  sub: string,
  now = Date.now(),
): string {
  const name = sessionCookieName(settings)
  return `${name}=${createSessionValue(settings, sub, now)}; ${cookieAttributes(settings)}`
}

export function clearSessionCookie(
  settings: SessionSettings & { ttlSeconds: number },
): string {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
  if (settings.secureCookie) attributes.push("Secure")
  return `${sessionCookieName(settings)}=; ${attributes.join("; ")}`
}

/** Minimal `Cookie` parser; only the first occurrence of a name wins. */
export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=")
    if (separator <= 0) continue
    const name = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1).trim()
    if (name && cookies[name] === undefined) cookies[name] = value
  }
  return cookies
}
