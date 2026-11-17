import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/env"

describe("loadEnv", () => {
  it("applies development defaults and warns about them", () => {
    const warnings: string[] = []
    const config = loadEnv({ source: {}, warn: (message) => warnings.push(message) })

    expect(config.PORT).toBe(8787)
    expect(config.WORKSPACE_DIR).toBe(process.cwd())
    expect(config.BACKEND_MODE).toBe("fake")
    expect(config.FAKE_SCENARIO).toBe("default")
    expect(config.OPENCODE_URL).toBe("http://127.0.0.1:4096")
    expect(config.OPENCODE_USERNAME).toBe("opencode")
    expect(config.OPENCHAT_USER).toBe("owner")
    expect(config.OPENCHAT_PASSWORD).toBe("openchat-dev")
    expect(config.AUTH_MODE).toBe("session")
    expect(config.SESSION_TTL_SECONDS).toBe(604_800)
    expect(config.COOKIE_SECURE).toBe(false)
    expect(config.SESSION_SECRET.length).toBeGreaterThanOrEqual(32)

    expect(warnings.some((entry) => entry.includes("OPENCHAT_PASSWORD"))).toBe(true)
    expect(warnings.some((entry) => entry.includes("SESSION_SECRET"))).toBe(true)
  })

  it("reads explicit values", () => {
    const config = loadEnv({
      source: {
        PORT: "9999",
        WORKSPACE_DIR: "/srv/workspace",
        BACKEND_MODE: "live",
        OPENCODE_URL: "http://opencode:4096",
        OPENCODE_PASSWORD: "opencode-secret",
        OPENCHAT_USER: "flo",
        OPENCHAT_PASSWORD: "app-secret",
        AUTH_MODE: "basic",
        SESSION_SECRET: "a".repeat(32),
        SESSION_TTL_SECONDS: "60",
        COOKIE_SECURE: "1",
      },
      warn: () => {},
    })

    expect(config).toMatchObject({
      PORT: 9999,
      WORKSPACE_DIR: "/srv/workspace",
      BACKEND_MODE: "live",
      OPENCODE_URL: "http://opencode:4096",
      OPENCHAT_USER: "flo",
      OPENCHAT_PASSWORD: "app-secret",
      AUTH_MODE: "basic",
      SESSION_SECRET: "a".repeat(32),
      SESSION_TTL_SECONDS: 60,
      COOKIE_SECURE: true,
    })
  })

  it("falls back from an unknown scenario", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: { FAKE_SCENARIO: "nope", OPENCHAT_PASSWORD: "x", SESSION_SECRET: "y" },
      warn: (message) => warnings.push(message),
    })
    expect(config.FAKE_SCENARIO).toBe("default")
    expect(warnings.some((entry) => entry.includes("FAKE_SCENARIO"))).toBe(true)
  })

  it("refuses the fake backend in production", () => {
    expect(() =>
      loadEnv({ source: { NODE_ENV: "production", BACKEND_MODE: "fake" }, warn: () => {} }),
    ).toThrow(/BACKEND_MODE=fake/)
  })
})

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

  it("refuses an unset password", () => {
    expect(() =>
      loadEnv({
        source: { ...production, OPENCHAT_PASSWORD: undefined },
        warn: () => {},
      }),
    ).toThrow(/OPENCHAT_PASSWORD/)
  })

  it("refuses the development default password without echoing it", () => {
    let message = ""
    try {
      loadEnv({ source: { ...production, OPENCHAT_PASSWORD: "openchat-dev" }, warn: () => {} })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/OPENCHAT_PASSWORD/)
    expect(message).not.toContain("openchat-dev")
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
