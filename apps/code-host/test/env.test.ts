import { describe, expect, it } from "vitest"
import { MAX_TICKET_TTL_SECONDS } from "@openchat/code-ticket"
import { loadEnv } from "../src/env"

function source(overrides: Record<string, string | undefined> = {}) {
  return { ...overrides }
}

describe("loadEnv defaults", () => {
  it("applies the development defaults and names unset variables in warnings", () => {
    const warnings: string[] = []
    const config = loadEnv({ source: source(), warn: (message) => warnings.push(message) })

    expect(config.HOST).toBe("127.0.0.1")
    expect(config.PORT).toBe(8090)
    expect(config.OPENCODE_URL).toBe("http://127.0.0.1:4096")
    expect(config.OPENCODE_USERNAME).toBe("opencode")
    expect(config.OPENCODE_PASSWORD).toBe("")
    expect(config.CODE_HOST_ORIGIN).toBe("http://127.0.0.1:8090")
    expect(config.APP_ORIGIN).toBe("http://127.0.0.1:8787")
    expect(config.CODE_TICKET_TTL_SECONDS).toBe(60)
    expect(config.CODE_SESSION_TTL_SECONDS).toBe(43_200)
    expect(config.COOKIE_SECURE).toBe(false)
    expect(config.ALLOW_INSECURE_COOKIE).toBe(false)
    expect(config.TRUST_PROXY).toBe(false)
    expect(config.CODE_TICKET_SECRET.length).toBeGreaterThanOrEqual(32)

    const text = warnings.join("\n")
    for (const key of ["CODE_TICKET_SECRET", "OPENCODE_PASSWORD", "CODE_HOST_ORIGIN", "APP_ORIGIN"]) {
      expect(text).toContain(key)
    }
  })

  it("reads explicit values", () => {
    const config = loadEnv({
      source: source({
        HOST: "0.0.0.0",
        PORT: "9999",
        OPENCODE_URL: "http://opencode.internal:4096/base/",
        OPENCODE_USERNAME: "owner",
        OPENCODE_PASSWORD: "upstream-secret",
        CODE_HOST_ORIGIN: "https://code.example.com",
        APP_ORIGIN: "https://chat.example.com/",
        CODE_TICKET_SECRET: "a".repeat(40),
        CODE_TICKET_TTL_SECONDS: "45",
        CODE_SESSION_TTL_SECONDS: "600",
        COOKIE_SECURE: "1",
        TRUST_PROXY: "1",
      }),
      warn: () => {},
    })

    expect(config).toMatchObject({
      HOST: "0.0.0.0",
      PORT: 9999,
      OPENCODE_URL: "http://opencode.internal:4096/base",
      OPENCODE_USERNAME: "owner",
      OPENCODE_PASSWORD: "upstream-secret",
      CODE_HOST_ORIGIN: "https://code.example.com",
      APP_ORIGIN: "https://chat.example.com",
      CODE_TICKET_SECRET: "a".repeat(40),
      CODE_TICKET_TTL_SECONDS: 45,
      CODE_SESSION_TTL_SECONDS: 600,
      COOKIE_SECURE: true,
      TRUST_PROXY: true,
    })
  })

  it("clamps an over-long ticket TTL in development without echoing the value", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: source({ CODE_TICKET_TTL_SECONDS: "600" }),
      warn: (message) => warnings.push(message),
    })
    expect(config.CODE_TICKET_TTL_SECONDS).toBe(MAX_TICKET_TTL_SECONDS)
    const text = warnings.join("\n")
    expect(text).toContain("CODE_TICKET_TTL_SECONDS")
    expect(text).not.toContain("600")
  })

  it("falls back from a non-numeric port and ticket TTL", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: source({ PORT: "eight", CODE_TICKET_TTL_SECONDS: "-4" }),
      warn: (message) => warnings.push(message),
    })
    expect(config.PORT).toBe(8090)
    expect(config.CODE_TICKET_TTL_SECONDS).toBe(60)
    const text = warnings.join("\n")
    expect(text).toContain("PORT")
    expect(text).toContain("CODE_TICKET_TTL_SECONDS")
    expect(text).not.toContain("eight")
    expect(text).not.toContain("-4")
  })

  it("fails the boot for malformed origins and upstream URLs", () => {
    expect(() => loadEnv({ source: source({ APP_ORIGIN: "not a url" }), warn: () => {} })).toThrow(
      /APP_ORIGIN/,
    )
    expect(() =>
      loadEnv({ source: source({ APP_ORIGIN: "ftp://chat.example.com" }), warn: () => {} }),
    ).toThrow(/APP_ORIGIN must use http or https/)
    expect(() =>
      loadEnv({ source: source({ CODE_HOST_ORIGIN: "https://code.example.com/path" }), warn: () => {} }),
    ).toThrow(/without a path/)
    expect(() =>
      loadEnv({ source: source({ APP_ORIGIN: "https://chat.example.com?x=1" }), warn: () => {} }),
    ).toThrow(/query or fragment/)
    expect(() =>
      loadEnv({
        source: source({ CODE_HOST_ORIGIN: "https://user:pass@code.example.com" }),
        warn: () => {},
      }),
    ).toThrow(/credentials/)
    expect(() =>
      loadEnv({ source: source({ OPENCODE_URL: "opencode:4096" }), warn: () => {} }),
    ).toThrow(/http or https/)
    expect(() =>
      loadEnv({ source: source({ OPENCODE_URL: "http://u:p@opencode:4096" }), warn: () => {} }),
    ).toThrow(/must not embed credentials/)
  })
})

describe("production hardening", () => {
  const production: Record<string, string | undefined> = {
    NODE_ENV: "production",
    CODE_TICKET_SECRET: "production-ticket-secret-production",
    OPENCODE_PASSWORD: "production-opencode-password",
    APP_ORIGIN: "https://chat.example.com",
    CODE_HOST_ORIGIN: "https://code.example.com",
    COOKIE_SECURE: "1",
  }

  function productionEnv(overrides: Record<string, string | undefined> = {}) {
    return source({ ...production, ...overrides })
  }

  it("boots with all required values", () => {
    const config = loadEnv({ source: productionEnv(), warn: () => {} })
    expect(config.CODE_TICKET_SECRET).toBe(production.CODE_TICKET_SECRET)
    expect(config.APP_ORIGIN).toBe("https://chat.example.com")
    expect(config.CODE_HOST_ORIGIN).toBe("https://code.example.com")
    expect(config.CODE_TICKET_TTL_SECONDS).toBe(60)
  })

  it("refuses a missing ticket secret", () => {
    expect(() =>
      loadEnv({ source: productionEnv({ CODE_TICKET_SECRET: undefined }), warn: () => {} }),
    ).toThrow(/CODE_TICKET_SECRET must be set/)
  })

  it("refuses a missing OpenCode password without echoing the secret", () => {
    let message = ""
    try {
      loadEnv({
        source: productionEnv({
          OPENCODE_PASSWORD: undefined,
          CODE_TICKET_SECRET: "do-not-log-this-ticket-secret",
        }),
        warn: () => {},
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/OPENCODE_PASSWORD/)
    expect(message).not.toContain("do-not-log-this-ticket-secret")
  })

  it("refuses a missing APP_ORIGIN", () => {
    expect(() =>
      loadEnv({ source: productionEnv({ APP_ORIGIN: undefined }), warn: () => {} }),
    ).toThrow(/APP_ORIGIN must be set/)
  })

  it("refuses a missing CODE_HOST_ORIGIN", () => {
    expect(() =>
      loadEnv({ source: productionEnv({ CODE_HOST_ORIGIN: undefined }), warn: () => {} }),
    ).toThrow(/CODE_HOST_ORIGIN must be set/)
  })

  it("refuses a plain-http APP_ORIGIN", () => {
    expect(() =>
      loadEnv({
        source: productionEnv({ APP_ORIGIN: "http://chat.example.com" }),
        warn: () => {},
      }),
    ).toThrow(/APP_ORIGIN must use https/)
  })

  it("refuses a plain-http CODE_HOST_ORIGIN", () => {
    expect(() =>
      loadEnv({
        source: productionEnv({ CODE_HOST_ORIGIN: "http://code.example.com" }),
        warn: () => {},
      }),
    ).toThrow(/CODE_HOST_ORIGIN must use https/)
  })

  it("refuses an insecure session cookie", () => {
    expect(() =>
      loadEnv({ source: productionEnv({ COOKIE_SECURE: undefined }), warn: () => {} }),
    ).toThrow(/COOKIE_SECURE/)
  })

  it("honours the explicit insecure-cookie opt-out and warns", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: productionEnv({ COOKIE_SECURE: undefined, ALLOW_INSECURE_COOKIE: "1" }),
      warn: (message) => warnings.push(message),
    })
    expect(config.COOKIE_SECURE).toBe(false)
    expect(warnings.some((entry) => entry.includes("ALLOW_INSECURE_COOKIE"))).toBe(true)
  })

  it("refuses a ticket TTL above the hard ceiling", () => {
    expect(() =>
      loadEnv({
        source: productionEnv({ CODE_TICKET_TTL_SECONDS: "61" }),
        warn: () => {},
      }),
    ).toThrow(/CODE_TICKET_TTL_SECONDS/)
  })

  it("never puts a value into a warning", () => {
    const warnings: string[] = []
    loadEnv({
      source: {
        CODE_TICKET_TTL_SECONDS: "600",
        OPENCODE_PASSWORD: "never-log-this-password",
        CODE_TICKET_SECRET: "never-log-this-secret",
        APP_ORIGIN: "http://app.internal.test",
        CODE_HOST_ORIGIN: "http://code.internal.test",
      },
      warn: (message) => warnings.push(message),
    })
    const text = warnings.join("\n")
    expect(text).not.toContain("never-log-this-password")
    expect(text).not.toContain("never-log-this-secret")
    expect(text).not.toContain("600")
  })
})

describe("bounds and deployment warnings", () => {
  function production(overrides: Record<string, string | undefined> = {}) {
    return {
      NODE_ENV: "production",
      CODE_TICKET_SECRET: "production-ticket-secret-production",
      OPENCODE_PASSWORD: "production-opencode-password",
      APP_ORIGIN: "https://code.example.com",
      CODE_HOST_ORIGIN: "https://code.example.com",
      COOKIE_SECURE: "1",
      ...overrides,
    }
  }

  it("rejects a PORT outside 1..65535 and keeps the boundary value", () => {
    const warnings: string[] = []
    const zero = loadEnv({ source: source({ PORT: "0" }), warn: (m) => warnings.push(m) })
    expect(zero.PORT).toBe(8090)
    expect(warnings.join("\n")).toContain("PORT")

    const tooHigh = loadEnv({
      source: source({ PORT: "99999" }),
      warn: (m) => warnings.push(m),
    })
    expect(tooHigh.PORT).toBe(8090)
    expect(warnings.join("\n")).not.toContain("99999")

    const boundary = loadEnv({ source: source({ PORT: "65535" }), warn: () => {} })
    expect(boundary.PORT).toBe(65_535)
  })

  it("caps CODE_SESSION_TTL_SECONDS at 30 days without echoing the value", () => {
    const warnings: string[] = []
    const capped = loadEnv({
      source: source({ CODE_SESSION_TTL_SECONDS: "2592001" }),
      warn: (m) => warnings.push(m),
    })
    expect(capped.CODE_SESSION_TTL_SECONDS).toBe(2_592_000)
    const text = warnings.join("\n")
    expect(text).toContain("CODE_SESSION_TTL_SECONDS")
    expect(text).not.toContain("2592001")

    const boundary = loadEnv({
      source: source({ CODE_SESSION_TTL_SECONDS: "2592000" }),
      warn: () => {},
    })
    expect(boundary.CODE_SESSION_TTL_SECONDS).toBe(2_592_000)
  })

  it("warns about a non-loopback bind in production but still boots", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: production({ HOST: "0.0.0.0" }),
      warn: (m) => warnings.push(m),
    })
    expect(config.HOST).toBe("0.0.0.0")
    const text = warnings.join("\n")
    expect(text).toContain("HOST is not a loopback address")
    expect(text).toContain("reverse proxy")
    expect(text).not.toContain("0.0.0.0")
  })

  it("stays quiet about a loopback bind in production", () => {
    const warnings: string[] = []
    loadEnv({ source: production({ HOST: "::1" }), warn: (m) => warnings.push(m) })
    expect(warnings.join("\n")).not.toContain("HOST is not a loopback address")
  })

  it("warns when the app and the Code host do not share a hostname", () => {
    const warnings: string[] = []
    loadEnv({
      source: source({
        APP_ORIGIN: "https://chat.example.com",
        CODE_HOST_ORIGIN: "https://code.example.com",
      }),
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).toContain("registrable domain")

    const same: string[] = []
    loadEnv({
      source: source({
        APP_ORIGIN: "https://code.example.com",
        CODE_HOST_ORIGIN: "https://code.example.com",
      }),
      warn: (m) => same.push(m),
    })
    expect(same.join("\n")).not.toContain("registrable domain")
  })
})
