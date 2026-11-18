import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  CODE_SESSION_COOKIE,
  SECURE_CODE_SESSION_COOKIE,
  clearSessionCookie,
  createSessionValue,
  parseCookies,
  readSessionValue,
  sessionCookie,
  sessionCookieName,
} from "../src/session"

const SECRET = "session-test-secret-session-test-secret"
const NOW = 1_700_000_000_000

function settings(overrides: Partial<{ secret: string; ttlSeconds: number; secureCookie: boolean }> = {}) {
  return { secret: SECRET, ttlSeconds: 3600, secureCookie: false, ...overrides }
}

describe("Code session value", () => {
  it("round-trips the subject", () => {
    const value = createSessionValue(settings(), "owner", NOW)
    expect(readSessionValue(value, settings(), NOW)).toBe("owner")
  })

  it("rejects a value signed with another secret", () => {
    const value = createSessionValue(settings(), "owner", NOW)
    expect(readSessionValue(value, settings({ secret: "other-secret-other-secret-other" }), NOW)).toBeNull()
  })

  it("rejects an expired value at the exact expiry second", () => {
    const value = createSessionValue(settings({ ttlSeconds: 60 }), "owner", NOW)
    expect(readSessionValue(value, settings({ ttlSeconds: 60 }), NOW + 59_000)).toBe("owner")
    expect(readSessionValue(value, settings({ ttlSeconds: 60 }), NOW + 60_000)).toBeNull()
  })

  it("rejects a tampered payload or signature", () => {
    const value = createSessionValue(settings(), "owner", NOW)
    const [version, payload, signature] = value.split(".") as [string, string, string]
    const other = Buffer.from(JSON.stringify({ sub: "intruder", exp: 9_999_999_999 })).toString(
      "base64url",
    )
    expect(readSessionValue(`${version}.${other}.${signature}`, settings(), NOW)).toBeNull()
    expect(
      readSessionValue(`${version}.${payload}.${signature.slice(0, -1)}A`, settings(), NOW),
    ).toBeNull()
  })

  it("never throws on hostile input", () => {
    const hostile = ["", ".", "..", "v1", "v1.payload", "v2.a.b", "v1.!!!.???", "not-a-cookie"]
    for (const value of hostile) {
      expect(readSessionValue(value, settings(), NOW)).toBeNull()
    }
    expect(readSessionValue(undefined, settings(), NOW)).toBeNull()
  })
})

describe("session cookie", () => {
  it("carries the fixed security attributes and no Domain", () => {
    const cookie = sessionCookie(settings({ ttlSeconds: 120 }), "owner", NOW)
    const [pair, ...attributes] = cookie.split("; ")
    expect(pair?.startsWith(`${CODE_SESSION_COOKIE}=v1.`)).toBe(true)
    expect(attributes).toEqual([
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=120",
    ])
    expect(cookie.toLowerCase()).not.toContain("domain")
    expect(cookie).not.toContain("Secure")
  })

  it("adds Secure when configured, switches to __Host- and keeps it host-only", () => {
    const cookie = sessionCookie(settings({ secureCookie: true }), "owner", NOW)
    expect(cookie.startsWith(`${SECURE_CODE_SESSION_COOKIE}=v1.`)).toBe(true)
    expect(cookie).toContain("; Secure")
    expect(cookie).toContain("Path=/")
    expect(cookie.toLowerCase()).not.toContain("domain")
  })

  it("uses one name per configuration", () => {
    expect(sessionCookieName({ secureCookie: false })).toBe(CODE_SESSION_COOKIE)
    expect(sessionCookieName({ secureCookie: true })).toBe(SECURE_CODE_SESSION_COOKIE)
    expect(SECURE_CODE_SESSION_COOKIE.startsWith("__Host-")).toBe(true)
  })

  it("clears with Max-Age=0 and the same flags", () => {
    const cookie = clearSessionCookie(settings({ secureCookie: true }))
    expect(cookie.startsWith(`${SECURE_CODE_SESSION_COOKIE}=;`)).toBe(true)
    expect(cookie).toContain("Max-Age=0")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie.toLowerCase()).not.toContain("domain")
  })
})

describe("parseCookies", () => {
  it("reads names, ignores malformed entries and keeps the first duplicate", () => {
    expect(parseCookies("oc_code=first; other=2; broken; =empty; oc_code=second")).toEqual({
      oc_code: "first",
      other: "2",
    })
    expect(parseCookies(null)).toEqual({})
  })
})

describe("derived session key", () => {
  it("is stable for one secret and changes with the secret", () => {
    const first = createSessionValue(settings(), "owner", NOW)
    const again = createSessionValue(settings(), "owner", NOW)
    expect(again).toBe(first)
    expect(
      createSessionValue(settings({ secret: `${SECRET}-other` }), "owner", NOW),
    ).not.toBe(first)
  })

  it("signs with HMAC(secret, label), not with the secret itself", () => {
    const value = createSessionValue(settings(), "owner", NOW)
    const [version, payload, signature] = value.split(".") as [string, string, string]
    const key = createHmac("sha256", SECRET).update("openchat:code-session").digest()

    const derived = createHmac("sha256", key)
      .update(`${version}.${payload}`)
      .digest("base64url")
    expect(derived).toBe(signature)

    // A value signed straight with CODE_TICKET_SECRET is not a session.
    const raw = createHmac("sha256", SECRET)
      .update(`${version}.${payload}`)
      .digest("base64url")
    expect(raw).not.toBe(signature)
  })
})
