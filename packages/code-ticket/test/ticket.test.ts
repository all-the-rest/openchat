import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  MAX_TICKET_CLOCK_SKEW_SECONDS,
  MAX_TICKET_TTL_SECONDS,
  TICKET_VERSION,
  mintTicket,
  readTicket,
} from "../src/index"

const SECRET = "ticket-secret-ticket-secret-ticket-secret"
const OTHER_SECRET = "another-secret-another-secret-another-secret"
const CODE_HOST = "https://code.example.com"
const NOW = 1_700_000_000_000

function read(token: string, overrides: Record<string, unknown> = {}) {
  return readTicket(token, { secret: SECRET, codeHost: CODE_HOST, now: NOW, ...overrides })
}

function forge(payload: string, secret = SECRET): string {
  const signature = createHmac("sha256", secret)
    .update(`${TICKET_VERSION}.${payload}`)
    .digest("base64url")
  return `${TICKET_VERSION}.${payload}.${signature}`
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

describe("mintTicket", () => {
  it("round-trips the claims through readTicket", () => {
    const token = mintTicket({
      sub: "owner",
      codeHost: CODE_HOST,
      secret: SECRET,
      ttlSeconds: 30,
      now: NOW,
      jti: "fixed-id",
    })
    expect(read(token)).toEqual({
      sub: "owner",
      codeHost: CODE_HOST,
      exp: Math.floor(NOW / 1000) + 30,
      jti: "fixed-id",
    })
  })

  it("uses the v1 version prefix and three dot-separated parts", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 60, now: NOW })
    const parts = token.split(".")
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe("v1")
  })

  it("generates a unique jti of at least 16 bytes per mint", () => {
    const jtis = new Set<string>()
    for (let index = 0; index < 50; index += 1) {
      const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 60, now: NOW })
      const claims = read(token)
      expect(claims).not.toBeNull()
      if (!claims) continue
      expect(Buffer.from(claims.jti, "base64url").byteLength).toBeGreaterThanOrEqual(16)
      jtis.add(claims.jti)
    }
    expect(jtis.size).toBe(50)
  })

  it("accepts the maximum TTL and refuses anything longer or non-positive", () => {
    expect(() =>
      mintTicket({
        sub: "owner",
        codeHost: CODE_HOST,
        secret: SECRET,
        ttlSeconds: MAX_TICKET_TTL_SECONDS,
        now: NOW,
      }),
    ).not.toThrow()
    expect(() =>
      mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 61, now: NOW }),
    ).toThrow(/60/)
    expect(() =>
      mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 0, now: NOW }),
    ).toThrow(/positive/)
    expect(() =>
      mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: -5, now: NOW }),
    ).toThrow(/positive/)
    expect(() =>
      mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 1.5, now: NOW }),
    ).toThrow(/positive/)
  })

  it("refuses empty subjects, audiences and secrets", () => {
    const base = { sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 10, now: NOW }
    expect(() => mintTicket({ ...base, sub: "" })).toThrow(/subject/)
    expect(() => mintTicket({ ...base, codeHost: "" })).toThrow(/audience/)
    expect(() => mintTicket({ ...base, secret: "" })).toThrow(/secret/)
  })
})

describe("readTicket", () => {
  it("rejects a token signed with another secret", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: OTHER_SECRET, ttlSeconds: 30, now: NOW })
    expect(read(token)).toBeNull()
  })

  it("rejects an expired token and accepts it one second before expiry", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 10, now: NOW })
    expect(read(token, { now: NOW + 9_000 })).not.toBeNull()
    expect(read(token, { now: NOW + 10_000 })).toBeNull()
    expect(read(token, { now: NOW + 60_000 })).toBeNull()
  })

  it("rejects an exp beyond the TTL ceiling plus the clock-skew allowance", () => {
    const nowSeconds = Math.floor(NOW / 1000)
    const claims = (exp: number) =>
      forge(encode({ sub: "owner", codeHost: CODE_HOST, exp, jti: "id" }))
    const ceiling = nowSeconds + MAX_TICKET_TTL_SECONDS + MAX_TICKET_CLOCK_SKEW_SECONDS

    expect(read(claims(ceiling))).not.toBeNull()
    expect(read(claims(ceiling + 1))).toBeNull()
    // A hand-rolled signer with the right secret cannot buy a long-lived token.
    expect(read(claims(nowSeconds + 86_400))).toBeNull()
  })

  it("applies the receiver's configured TTL to the read ceiling", () => {
    const nowSeconds = Math.floor(NOW / 1000)
    const claims = (exp: number) =>
      forge(encode({ sub: "owner", codeHost: CODE_HOST, exp, jti: "id" }))

    // 100 s sits inside the fixed 60 s + 60 s skew ceiling ...
    expect(read(claims(nowSeconds + 100))).not.toBeNull()
    // ... but a receiver configured for 20 s refuses it.
    expect(read(claims(nowSeconds + 100), { ttlSeconds: 20 })).toBeNull()
    expect(read(claims(nowSeconds + 20), { ttlSeconds: 20 })).not.toBeNull()

    // An out-of-range configured TTL is clamped to the hard ceiling instead of
    // disabling the check.
    expect(read(claims(nowSeconds + 3_600), { ttlSeconds: 100_000 })).toBeNull()
  })

  it("rejects a ticket bound to another Code host", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 30, now: NOW })
    expect(read(token, { codeHost: "https://code.example.org" })).toBeNull()
    expect(read(token, { codeHost: "https://code.example.com.evil.test" })).toBeNull()
    expect(read(token, { codeHost: "https://code.example.co" })).toBeNull()
    expect(read(token, { codeHost: `${CODE_HOST}/` })).toBeNull()
  })

  it("rejects a tampered payload while keeping a valid-shaped signature", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 30, now: NOW })
    const [, payload, signature] = token.split(".") as [string, string, string]
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
    const otherPayload = encode({ ...claims, sub: "intruder" })
    expect(read(`v1.${otherPayload}.${signature}`)).toBeNull()
  })

  it("rejects a tampered signature", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 30, now: NOW })
    const [, payload, signature] = token.split(".") as [string, string, string]
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A")
    expect(read(`v1.${payload}.${flipped}`)).toBeNull()
  })

  it("rejects a wrong version prefix even with a valid signature", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 30, now: NOW })
    const [, payload, signature] = token.split(".") as [string, string, string]
    expect(read(`v2.${payload}.${signature}`)).toBeNull()
    expect(read(`v1x.${payload}.${signature}`)).toBeNull()
  })

  it("rejects malformed input without throwing", () => {
    const token = mintTicket({ sub: "owner", codeHost: CODE_HOST, secret: SECRET, ttlSeconds: 30, now: NOW })
    const [, payload, signature] = token.split(".") as [string, string, string]
    const hostile: Array<string> = [
      "",
      ".",
      "..",
      "v1",
      "v1.payload",
      "v1.payload.signature.extra",
      "v1.." + signature,
      `v1.${payload}.`,
      "v1.!!!.???",
      `v1.${payload}.${signature}=`,
      `v1.${payload}.${signature}\n`,
      "not-a-token",
      "v1.eyJzdWIiOiJvd25lciJ9." + signature,
    ]
    for (const entry of hostile) {
      expect(read(entry)).toBeNull()
    }
    expect(readTicket(undefined as unknown as string, { secret: SECRET, codeHost: CODE_HOST })).toBeNull()
    expect(readTicket(token, { secret: "", codeHost: CODE_HOST })).toBeNull()
  })

  it("rejects well-signed claims with a bad shape or past expiry", () => {
    const valid = { sub: "owner", codeHost: CODE_HOST, exp: Math.floor(NOW / 1000) + 10, jti: "id" }
    expect(read(forge(encode({ ...valid, sub: "" })))).toBeNull()
    expect(read(forge(encode({ ...valid, codeHost: 123 })))).toBeNull()
    expect(read(forge(encode({ ...valid, exp: "soon" })))).toBeNull()
    expect(read(forge(encode({ ...valid, exp: 0 })))).toBeNull()
    expect(read(forge(encode({ ...valid, exp: 1.5 })))).toBeNull()
    expect(read(forge(encode({ ...valid, jti: "" })))).toBeNull()
    expect(read(forge(encode({ ...valid, exp: Math.floor(NOW / 1000) })))).toBeNull()
    expect(read(forge(encode([valid])))).toBeNull()
    expect(read(forge("bm90LWpzb24"))).toBeNull()
  })
})
