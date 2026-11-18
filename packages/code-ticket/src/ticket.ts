import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * A Code host ticket is a short-lived, single-use grant minted by the
 * authenticated app and redeemed by the Code host for its own cookie.
 *
 * Token shape: `v1.<base64url(claims)>.<base64url(HMAC-SHA256)>`. The HMAC
 * covers `v1.<claims>`, so the version cannot be swapped without detection.
 * This module is server-side only and has no HTTP dependency; the Code host
 * owns replay detection because only it sees the redemption.
 */
export const TICKET_VERSION = "v1"

/**
 * Hard ceiling for a ticket's lifetime. The exchange is a redirect in the
 * same browser, so a minute is generous; a longer value only widens the
 * window for a leaked ticket.
 */
export const MAX_TICKET_TTL_SECONDS = 60

/** Bytes of randomness in a generated `jti` (base64url encodes 24 as 32 chars). */
const JTI_BYTES = 24

const BASE64URL = /^[A-Za-z0-9_-]+$/

export interface TicketClaims {
  /** The app user the ticket was minted for. */
  sub: string
  /** The Code host origin the ticket is valid for (audience binding). */
  codeHost: string
  /** Expiry as epoch seconds. */
  exp: number
  /** Unique id; the Code host rejects a second redemption. */
  jti: string
}

export interface MintTicketOptions {
  sub: string
  codeHost: string
  secret: string
  ttlSeconds: number
  /** Epoch milliseconds, the same shape as `Date.now()`. */
  now?: number
  /** Injected for tests; generated from 24 random bytes otherwise. */
  jti?: string
}

export interface ReadTicketOptions {
  secret: string
  /** The Code host's own origin; a ticket for another host is rejected. */
  codeHost: string
  /** Epoch milliseconds, the same shape as `Date.now()`. */
  now?: number
}

/** Fixed-length constant-time compare; hashing hides the input lengths. */
function constantTimeEqual(left: string, right: string): boolean {
  const digestLeft = createHash("sha256").update(left).digest()
  const digestRight = createHash("sha256").update(right).digest()
  return timingSafeEqual(digestLeft, digestRight)
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

function encodePayload(claims: TicketClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")
}

function decodePayload(payload: string): TicketClaims | null {
  if (!BASE64URL.test(payload)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const { sub, codeHost, exp, jti } = record
  if (typeof sub !== "string" || sub.length === 0) return null
  if (typeof codeHost !== "string" || codeHost.length === 0) return null
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp <= 0) return null
  if (typeof jti !== "string" || jti.length === 0) return null
  return { sub, codeHost, exp, jti }
}

/**
 * Mints a ticket. Refuses a TTL outside `1..MAX_TICKET_TTL_SECONDS` and empty
 * inputs instead of producing a token that would later fail at the Code host.
 */
export function mintTicket(options: MintTicketOptions): string {
  const { sub, codeHost, secret, ttlSeconds } = options
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("A ticket secret is required")
  }
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("A ticket subject is required")
  }
  if (typeof codeHost !== "string" || codeHost.length === 0) {
    throw new Error("A ticket audience is required")
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Ticket TTL must be a positive integer number of seconds")
  }
  if (ttlSeconds > MAX_TICKET_TTL_SECONDS) {
    throw new Error(`Ticket TTL must not exceed ${MAX_TICKET_TTL_SECONDS} seconds`)
  }

  const now = options.now ?? Date.now()
  const claims: TicketClaims = {
    sub,
    codeHost,
    exp: Math.floor(now / 1000) + ttlSeconds,
    jti: options.jti ?? randomBytes(JTI_BYTES).toString("base64url"),
  }
  const payload = encodePayload(claims)
  const signature = sign(`${TICKET_VERSION}.${payload}`, secret)
  return `${TICKET_VERSION}.${payload}.${signature}`
}

/**
 * Verifies a ticket and returns its claims, or `null` for anything that is
 * malformed, tampered with, expired, or bound to another Code host. The
 * signature is checked before the claims are parsed, and the whole function
 * never throws on hostile input.
 */
export function readTicket(token: string, options: ReadTicketOptions): TicketClaims | null {
  try {
    if (typeof token !== "string") return null
    if (typeof options.secret !== "string" || options.secret.length === 0) return null
    if (typeof options.codeHost !== "string" || options.codeHost.length === 0) return null

    const parts = token.split(".")
    if (parts.length !== 3) return null
    const [version, payload, signature] = parts
    if (version !== TICKET_VERSION) return null
    if (!payload || !signature) return null
    if (!BASE64URL.test(signature)) return null

    const expected = sign(`${version}.${payload}`, options.secret)
    if (!constantTimeEqual(signature, expected)) return null

    const claims = decodePayload(payload)
    if (!claims) return null

    const now = options.now ?? Date.now()
    if (claims.exp <= Math.floor(now / 1000)) return null
    if (!constantTimeEqual(claims.codeHost, options.codeHost)) return null
    return claims
  } catch {
    return null
  }
}
