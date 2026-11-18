import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/env"
import {
  CODE_SESSION_COOKIE,
  clearSessionCookie,
  createSessionValue,
  parseCookies,
  readSessionValue,
  sessionCookie,
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

  it("adds Secure when configured and keeps it host-only", () => {
    const cookie = sessionCookie(settings({ secureCookie: true }), "owner", NOW)
    expect(cookie).toContain("; Secure")
    expect(cookie.toLowerCase()).not.toContain("domain")
  })

  it("clears with Max-Age=0 and the same flags", () => {
    const cookie = clearSessionCookie(settings({ secureCookie: true }))
    expect(cookie.startsWith(`${CODE_SESSION_COOKIE}=;`)).toBe(true)
    expect(cookie).toContain("Max-Age=0")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
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

describe("production boot", () => {
  it("derives a session key from CODE_TICKET_SECRET", () => {
    const config = loadEnv({
      source: {
        NODE_ENV: "production",
        CODE_TICKET_SECRET: "a-production-ticket-secret-1234",
        OPENCODE_PASSWORD: "upstream-password",
        APP_ORIGIN: "https://chat.example.com",
        CODE_HOST_ORIGIN: "https://code.example.com",
        COOKIE_SECURE: "1",
      },
      warn: () => {},
    })
    expect(config.CODE_TICKET_SECRET).toBe("a-production-ticket-secret-1234")
  })
})
