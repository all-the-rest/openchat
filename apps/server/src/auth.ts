import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { compare } from "bcryptjs"

/**
 * The app session cookie. With `Secure` the name carries the `__Host-` prefix:
 * a browser then refuses any cookie with that name that also carries a `Domain`
 * attribute, so a sibling subdomain cannot shadow or toss it. Development keeps
 * the plain name so a cookie set over plain HTTP still works. Only the name that
 * matches the current configuration is read, never both.
 */
export const SESSION_COOKIE = "oc_session"
export const SECURE_SESSION_COOKIE = "__Host-oc_session"

export interface AuthSettings {
  mode: "session" | "basic"
  user: string
  /** Plaintext credential; empty when `passwordHash` is configured. */
  password: string
  /** bcrypt hash (`$2a$`, `$2b$` or `$2y$`); empty for a plaintext deployment. */
  passwordHash: string
  secret: string
  /**
   * Cookie-signing key derived once per boot from `secret` and the credential.
   * Never the raw secret, and never the credential itself.
   */
  signingKey: string
  ttlSeconds: number
  secureCookie: boolean
}

/** Hashes both inputs to a fixed length before the constant-time compare. */
export function constantTimeEqual(left: string, right: string): boolean {
  const digestLeft = createHash("sha256").update(left).digest()
  const digestRight = createHash("sha256").update(right).digest()
  return timingSafeEqual(digestLeft, digestRight)
}

/**
 * Domain separator for the derived cookie key. Changing it invalidates every
 * issued cookie, so it is versioned rather than renamed on a whim.
 */
const SIGNING_KEY_LABEL = "openchat-session-key-v1"

/**
 * Derives the cookie-signing key from `SESSION_SECRET` and the configured
 * credential (bcrypt hash, or the plaintext password where that is configured).
 * `SESSION_SECRET` is the HMAC key, the credential is the message, so the
 * resulting key never equals the secret and the bcrypt hash is not recoverable
 * from it.
 *
 * Because the cookie signature depends on the credential, changing the password
 * invalidates every cookie minted against the old one without a session store.
 * Rotating `SESSION_SECRET` still invalidates everything.
 *
 * Called from `authSettings`, which runs once per boot: not on the request path.
 * Basic mode sets no cookie, so the key is unused there, but deriving it keeps
 * both modes on one code path.
 */
export function deriveSigningKey(
  settings: Pick<AuthSettings, "secret" | "password" | "passwordHash">,
): string {
  const credential = settings.passwordHash || settings.password
  return createHmac("sha256", settings.secret)
    .update(`${SIGNING_KEY_LABEL}\u0000${credential}`)
    .digest("base64url")
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url")
}

export function createSessionValue(
  settings: AuthSettings,
  now = Date.now(),
): string {
  const expires = Math.floor(now / 1000) + settings.ttlSeconds
  const payload = `${settings.user}.${expires}`
  return `${payload}.${sign(payload, settings.signingKey)}`
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
  if (!constantTimeEqual(signature, sign(payload, settings.signingKey))) return null
  if (!constantTimeEqual(user, settings.user)) return null
  return user
}

/** The only cookie name the current configuration accepts. */
export function sessionCookieName(
  settings: Pick<AuthSettings, "secureCookie">,
): string {
  return settings.secureCookie ? SECURE_SESSION_COOKIE : SESSION_COOKIE
}

function cookieAttributes(settings: AuthSettings, maxAge: number): string {
  const attributes = [`Path=/`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`]
  if (settings.secureCookie) attributes.push("Secure")
  return attributes.join("; ")
}

export function sessionCookie(settings: AuthSettings, now = Date.now()): string {
  const name = sessionCookieName(settings)
  return `${name}=${createSessionValue(settings, now)}; ${cookieAttributes(settings, settings.ttlSeconds)}`
}

/**
 * Clears the cookie in this browser only. There is no server-side session
 * store, so a copied value keeps working until its TTL — but a password change
 * (or a `SESSION_SECRET` rotation) changes the derived signing key and
 * invalidates every cookie minted before it.
 */
export function clearSessionCookie(settings: AuthSettings): string {
  return `${sessionCookieName(settings)}=; ${cookieAttributes(settings, 0)}`
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

/**
 * Verifies a login attempt. The username is compared constant-time first, but
 * the password check always runs: a wrong username costs the same hash work as
 * a wrong password, and only the combined result decides. That keeps an
 * unknown user from answering measurably faster than a known one.
 *
 * A configured hash is verified with bcrypt; otherwise the plaintext compare
 * stays. The caller throttles failures, so this function only decides.
 */
export async function verifyCredentials(
  user: string,
  password: string,
  settings: AuthSettings,
): Promise<string | null> {
  const userMatches = constantTimeEqual(user, settings.user)
  const passwordMatches = settings.passwordHash
    ? await compareHash(password, settings.passwordHash)
    : constantTimeEqual(password, settings.password)
  return userMatches && passwordMatches ? settings.user : null
}

/** Injectable seam so tests can hold a verification open. */
export type CredentialVerifier = (
  user: string,
  password: string,
  settings: AuthSettings,
) => Promise<string | null>

/** `compare` throws on a malformed hash; a malformed hash must deny. */
async function compareHash(password: string, hash: string): Promise<boolean> {
  try {
    return await compare(password, hash)
  } catch {
    return false
  }
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
  // Basic auth only knows the plaintext pair; config refuses hash + basic.
  if (!settings.password) return null
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
  // Only the active name authenticates: when Secure is on, a `oc_session`
  // cookie planted by an older release or a sibling subdomain is ignored.
  const value = cookies[sessionCookieName(settings)]
  if (!value) return null
  return readSessionValue(value, settings, now)
}
