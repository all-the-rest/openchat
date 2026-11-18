import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/env"

/**
 * Login credential rules and the production guards that depend on them.
 * Split from `env.test.ts` to keep both files under the 400-line ceiling.
 */
describe("production hardening", () => {
  const production = {
    NODE_ENV: "production",
    BACKEND_MODE: "live",
    OPENCODE_PASSWORD: "opencode-secret",
    SESSION_SECRET: "a".repeat(32),
    COOKIE_SECURE: "1",
    OPENCHAT_PASSWORD: "app-secret",
  }

  it("boots with an explicit password, secret and secure cookie", () => {
    const config = loadEnv({ source: production, warn: () => {} })
    expect(config.OPENCHAT_PASSWORD).toBe("app-secret")
    expect(config.SESSION_SECRET).toBe(production.SESSION_SECRET)
    expect(config.COOKIE_SECURE).toBe(true)
  })

  it("refuses a boot without a credential", () => {
    expect(() =>
      loadEnv({
        source: { ...production, OPENCHAT_PASSWORD: undefined },
        warn: () => {},
      }),
    ).toThrow(/OPENCHAT_PASSWORD/)
  })

  it("refuses both credentials at once", () => {
    expect(() =>
      loadEnv({
        source: {
          ...production,
          OPENCHAT_PASSWORD_HASH:
            "$2a$04$Yq4Me9RVGpnS4XyTf0tQPuN/p6CYrC22mxsDjzEp9Tpg3m6Qrlbpq",
        },
        warn: () => {},
      }),
    ).toThrow(/only one of OPENCHAT_PASSWORD and OPENCHAT_PASSWORD_HASH/)
  })

  it("boots with a bcrypt hash and no plaintext", () => {
    const config = loadEnv({
      source: {
        ...production,
        OPENCHAT_PASSWORD: undefined,
        OPENCHAT_PASSWORD_HASH:
          "$2a$14$xUGHyfCymA1730uBuUhEBevc3P6U0PayWlLwfwXQpxrc03w36xeH6",
      },
      warn: () => {},
    })
    expect(config.OPENCHAT_PASSWORD).toBe("")
    expect(config.OPENCHAT_PASSWORD_HASH).toMatch(/^\$2a\$14\$/)
  })

  it("refuses an unset session secret", () => {
    expect(() =>
      loadEnv({
        source: { ...production, SESSION_SECRET: undefined },
        warn: () => {},
      }),
    ).toThrow(/SESSION_SECRET/)
  })

  it("refuses an insecure session cookie", () => {
    expect(() =>
      loadEnv({
        source: { ...production, COOKIE_SECURE: undefined },
        warn: () => {},
      }),
    ).toThrow(/COOKIE_SECURE/)
  })

  it("allows basic auth without a secure cookie", () => {
    const config = loadEnv({
      source: { ...production, AUTH_MODE: "basic", COOKIE_SECURE: undefined },
      warn: () => {},
    })
    expect(config.AUTH_MODE).toBe("basic")
    expect(config.COOKIE_SECURE).toBe(false)
  })

  it("honours the explicit insecure-cookie opt-out", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: {
        ...production,
        COOKIE_SECURE: undefined,
        ALLOW_INSECURE_COOKIE: "1",
      },
      warn: (message) => warnings.push(message),
    })
    expect(config.COOKIE_SECURE).toBe(false)
    expect(warnings.some((warning) => warning.includes("ALLOW_INSECURE_COOKIE"))).toBe(true)
  })
})

describe("login credentials", () => {
  const HASH = "$2a$04$Yq4Me9RVGpnS4XyTf0tQPuN/p6CYrC22mxsDjzEp9Tpg3m6Qrlbpq"

  it.each([
    ["a plaintext value", "not-a-hash"],
    ["a truncated digest", "$2a$04$Yq4Me9RVGpnS4XyTf0tQPuN"],
    ["an unknown revision", HASH.replace("$2a$", "$2c$")],
    ["an out-of-range cost", HASH.replace("$04$", "$99$")],
  ])("refuses %s as OPENCHAT_PASSWORD_HASH", (_label, value) => {
    expect(() =>
      loadEnv({
        source: { OPENCHAT_PASSWORD: undefined, OPENCHAT_PASSWORD_HASH: value },
        warn: () => {},
      }),
    ).toThrow(/bcrypt hash/)
  })

  it("refuses to pair a hash with basic auth", () => {
    expect(() =>
      loadEnv({
        source: {
          OPENCHAT_PASSWORD: undefined,
          OPENCHAT_PASSWORD_HASH: HASH,
          AUTH_MODE: "basic",
        },
        warn: () => {},
      }),
    ).toThrow(/AUTH_MODE=basic requires OPENCHAT_PASSWORD/)
  })
})
