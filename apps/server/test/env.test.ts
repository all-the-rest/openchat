import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/env"

describe("loadEnv", () => {
  it("applies development defaults and warns about them", () => {
    const warnings: string[] = []
    const config = loadEnv({ source: {}, warn: (message) => warnings.push(message) })

    expect(config.PORT).toBe(8787)
    expect(config.HOST).toBe("127.0.0.1")
    expect(config.TRUST_PROXY).toBe(false)
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
    expect(config.STT_URL).toBe("")
    expect(config.STT_API_KEY).toBe("")
    expect(config.DICTATION_MAX_SECONDS).toBe(120)
    expect(config.DICTATION_MAX_BYTES).toBe(26_214_400)
    expect(config.SESSION_SECRET.length).toBeGreaterThanOrEqual(32)

    expect(warnings.some((entry) => entry.includes("OPENCHAT_PASSWORD"))).toBe(true)
    expect(warnings.some((entry) => entry.includes("SESSION_SECRET"))).toBe(true)
  })

  it("reads explicit values", () => {
    const config = loadEnv({
      source: {
        HOST: "0.0.0.0",
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
        TRUST_PROXY: "1",
        STT_URL: "http://stt:8080/v1",
        STT_API_KEY: "stt-secret-key",
        DICTATION_MAX_SECONDS: "45",
        DICTATION_MAX_BYTES: "1048576",
      },
      warn: () => {},
    })

    expect(config).toMatchObject({
      HOST: "0.0.0.0",
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
      TRUST_PROXY: true,
      STT_URL: "http://stt:8080/v1",
      STT_API_KEY: "stt-secret-key",
      DICTATION_MAX_SECONDS: 45,
      DICTATION_MAX_BYTES: 1_048_576,
    })
  })

  it("treats a blank STT_URL as no dictation service", () => {
    const config = loadEnv({ source: { STT_URL: "   " }, warn: () => {} })
    expect(config.STT_URL).toBe("")
  })

  it("falls back from invalid dictation caps without echoing values", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: {
        STT_API_KEY: "never-log-this-key",
        DICTATION_MAX_SECONDS: "not-a-number",
        DICTATION_MAX_BYTES: "-5",
      },
      warn: (message) => warnings.push(message),
    })

    expect(config.DICTATION_MAX_SECONDS).toBe(120)
    expect(config.DICTATION_MAX_BYTES).toBe(26_214_400)
    const text = warnings.join("\n")
    expect(text).toContain("DICTATION_MAX_SECONDS")
    expect(text).toContain("DICTATION_MAX_BYTES")
    expect(text).not.toContain("not-a-number")
    expect(text).not.toContain("-5")
    expect(text).not.toContain("never-log-this-key")
  })

  it("accepts a remote OPENCODE_URL and strips trailing slashes", () => {
    const config = loadEnv({
      source: { OPENCODE_URL: "http://10.0.0.5:4096/" },
      warn: () => {},
    })
    expect(config.OPENCODE_URL).toBe("http://10.0.0.5:4096")

    const tunnel = loadEnv({
      source: { OPENCODE_URL: "http://127.0.0.1:4096/prefix/" },
      warn: () => {},
    })
    expect(tunnel.OPENCODE_URL).toBe("http://127.0.0.1:4096/prefix")

    // A query or fragment is dropped; URL resolution would ignore it anyway.
    const withQuery = loadEnv({
      source: { OPENCODE_URL: "http://10.0.0.5:4096/?token=abc/" },
      warn: () => {},
    })
    expect(withQuery.OPENCODE_URL).toBe("http://10.0.0.5:4096")
  })

  it("fails the boot for a malformed or credential-bearing OPENCODE_URL", () => {
    expect(() =>
      loadEnv({ source: { OPENCODE_URL: "opencode:4096" }, warn: () => {} }),
    ).toThrow("must use http or https")
    expect(() =>
      loadEnv({ source: { OPENCODE_URL: "not a url" }, warn: () => {} }),
    ).toThrow("absolute http(s) URL")
    expect(() =>
      loadEnv({ source: { OPENCODE_URL: "ftp://opencode:4096" }, warn: () => {} }),
    ).toThrow("must use http or https")
    expect(() =>
      loadEnv({
        source: { OPENCODE_URL: "http://owner:secret@10.0.0.5:4096" },
        warn: () => {},
      }),
    ).toThrow("must not embed credentials")
  })

  it("clamps an absurd byte cap to the ceiling and says why", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: { DICTATION_MAX_BYTES: "999999999999" },
      warn: (message) => warnings.push(message),
    })

    expect(config.DICTATION_MAX_BYTES).toBe(104_857_600)
    const text = warnings.join("\n")
    expect(text).toContain("DICTATION_MAX_BYTES")
    expect(text).toContain("100 MiB")
    expect(text).not.toContain("999999999999")
  })

  it("binds loopback unless HOST is set explicitly", () => {
    // Container images set HOST=0.0.0.0; a bare local start must not listen on
    // every interface.
    const config = loadEnv({ source: {}, warn: () => {} })
    expect(config.HOST).toBe("127.0.0.1")
    expect(loadEnv({ source: { HOST: "0.0.0.0" }, warn: () => {} }).HOST).toBe("0.0.0.0")
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

describe("Code surface env", () => {
  const productionCode = {
    NODE_ENV: "production",
    BACKEND_MODE: "live",
    OPENCODE_PASSWORD: "opencode-secret",
    SESSION_SECRET: "a".repeat(32),
    COOKIE_SECURE: "1",
    OPENCHAT_PASSWORD: "app-secret",
    CODE_HOST_ORIGIN: "https://code.example.com",
    CODE_TICKET_SECRET: "code-ticket-secret",
  }

  it("defaults to an unconfigured surface without warnings", () => {
    const warnings: string[] = []
    const config = loadEnv({ source: {}, warn: (message) => warnings.push(message) })

    expect(config.CODE_HOST_ORIGIN).toBe("")
    expect(config.CODE_TICKET_SECRET).toBe("")
    expect(config.CODE_TICKET_TTL_SECONDS).toBe(60)
    expect(config.CODE_STATUS_TIMEOUT_MS).toBe(2000)
    expect(warnings.some((warning) => warning.includes("CODE_"))).toBe(false)
  })

  it("reads a bare origin, the secret, TTL and timeout", () => {
    const config = loadEnv({
      source: {
        CODE_HOST_ORIGIN: "https://code.example.com/",
        CODE_TICKET_SECRET: "code-ticket-secret",
        CODE_TICKET_TTL_SECONDS: "45",
        CODE_STATUS_TIMEOUT_MS: "500",
      },
      warn: () => {},
    })

    expect(config.CODE_HOST_ORIGIN).toBe("https://code.example.com")
    expect(config.CODE_TICKET_SECRET).toBe("code-ticket-secret")
    expect(config.CODE_TICKET_TTL_SECONDS).toBe(45)
    expect(config.CODE_STATUS_TIMEOUT_MS).toBe(500)
  })

  it("fails the boot for an origin that is not a bare http(s) origin", () => {
    const invalid = [
      "https://code.example.com/api",
      "https://code.example.com/?token=abc",
      "https://code.example.com/#fragment",
      "https://owner:secret@code.example.com",
      "ftp://code.example.com",
      "not a url",
    ]
    for (const value of invalid) {
      let message = ""
      try {
        loadEnv({ source: { CODE_HOST_ORIGIN: value }, warn: () => {} })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain("CODE_HOST_ORIGIN")
      expect(message).not.toContain(value)
      expect(message).not.toContain("secret@")
    }
  })

  it("generates an ephemeral ticket secret in development and warns", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: { CODE_HOST_ORIGIN: "http://127.0.0.1:8090" },
      warn: (message) => warnings.push(message),
    })

    expect(config.CODE_TICKET_SECRET.length).toBeGreaterThanOrEqual(32)
    const text = warnings.join("\n")
    expect(text).toContain("CODE_TICKET_SECRET")
    expect(text).not.toContain("127.0.0.1")
  })

  it("refuses a production boot without a ticket secret", () => {
    let message = ""
    try {
      loadEnv({
        source: { ...productionCode, CODE_TICKET_SECRET: undefined },
        warn: () => {},
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("CODE_TICKET_SECRET")
    expect(message).not.toContain("code.example.com")
  })

  it("requires https for the origin in production", () => {
    expect(() =>
      loadEnv({
        source: { ...productionCode, CODE_HOST_ORIGIN: "http://code.example.com" },
        warn: () => {},
      }),
    ).toThrow(/CODE_HOST_ORIGIN.*https/)
  })

  it("boots production with a secure origin and secret", () => {
    const config = loadEnv({ source: productionCode, warn: () => {} })
    expect(config.CODE_HOST_ORIGIN).toBe("https://code.example.com")
    expect(config.CODE_TICKET_SECRET).toBe("code-ticket-secret")
  })

  it("clamps the TTL to 60 s in development and refuses it in production", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: { CODE_TICKET_TTL_SECONDS: "120" },
      warn: (message) => warnings.push(message),
    })
    expect(config.CODE_TICKET_TTL_SECONDS).toBe(60)
    const text = warnings.join("\n")
    expect(text).toContain("CODE_TICKET_TTL_SECONDS")
    expect(text).not.toContain("120")

    expect(() =>
      loadEnv({
        source: { ...productionCode, CODE_TICKET_TTL_SECONDS: "120" },
        warn: () => {},
      }),
    ).toThrow(/CODE_TICKET_TTL_SECONDS/)
  })

  it("falls back from an invalid status timeout without echoing the value", () => {
    const warnings: string[] = []
    const config = loadEnv({
      source: { CODE_STATUS_TIMEOUT_MS: "not-a-number" },
      warn: (message) => warnings.push(message),
    })
    expect(config.CODE_STATUS_TIMEOUT_MS).toBe(2000)
    const text = warnings.join("\n")
    expect(text).toContain("CODE_STATUS_TIMEOUT_MS")
    expect(text).not.toContain("not-a-number")
  })
})
