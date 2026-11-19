import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/env"
import type { EnvConfig } from "../src/env"

const KEY = "test-artifact-signing-key-0123456789"

function load(
  overrides: Record<string, string | undefined> = {},
  warn: (message: string) => void = () => {},
): EnvConfig {
  return loadEnv({
    source: {
      WORKSPACE_DIR: "/workspace",
      OPENCHAT_PASSWORD: "secret-password",
      SESSION_SECRET: "test-secret-test-secret-test-secret",
      MEMORY_INTERNAL_TOKEN: "test-memory-internal-token-0123456789",
      ...overrides,
    },
    warn,
  })
}

describe("artifact environment defaults", () => {
  it("leaves the surface unconfigured and stores under the workspace", () => {
    const config = load()
    expect(config.ARTIFACT_HOST_URL).toBe("")
    expect(config.ARTIFACT_SIGNING_KEY).toBe("")
    expect(config.ARTIFACTS_DIR).toBe(join("/workspace", ".openchat-artifacts"))
  })

  it("keeps both configured values", () => {
    const config = load({
      ARTIFACT_HOST_URL: "https://artifacts.example.com",
      ARTIFACT_SIGNING_KEY: KEY,
    })
    expect(config.ARTIFACT_HOST_URL).toBe("https://artifacts.example.com")
    expect(config.ARTIFACT_SIGNING_KEY).toBe(KEY)
  })

  it("honours an explicit directory", () => {
    expect(load({ ARTIFACTS_DIR: "/srv/artifacts" }).ARTIFACTS_DIR).toBe("/srv/artifacts")
  })

  it("drops a trailing slash but keeps a path prefix", () => {
    expect(load({ ARTIFACT_HOST_URL: "http://host:4100///" }).ARTIFACT_HOST_URL).toBe(
      "http://host:4100",
    )
    expect(load({ ARTIFACT_HOST_URL: "http://host:4100/a/" }).ARTIFACT_HOST_URL).toBe(
      "http://host:4100/a",
    )
  })
})

describe("artifact environment warnings", () => {
  it.each([
    ["an unset key", { ARTIFACT_HOST_URL: "http://host:4100" }, /ARTIFACT_SIGNING_KEY is unset/],
    ["an unset host", { ARTIFACT_SIGNING_KEY: KEY }, /ARTIFACT_HOST_URL is unset/],
  ])("warns about %s and keeps the surface hidden", (_label, overrides, pattern) => {
    const warnings: string[] = []
    const config = load(overrides, (message) => warnings.push(message))
    expect(warnings.join("\n")).toMatch(pattern)
    expect(config.ARTIFACT_HOST_URL === "" || config.ARTIFACT_SIGNING_KEY === "").toBe(true)
  })

  it("never puts a value in the warning", () => {
    const warnings: string[] = []
    load({ ARTIFACT_SIGNING_KEY: KEY }, (message) => warnings.push(message))
    expect(warnings.join("\n")).not.toContain(KEY)
  })
})

describe("artifact environment: internal token", () => {
  it("stays empty while the surface is unconfigured", () => {
    expect(load().ARTIFACT_INTERNAL_TOKEN).toBe("")
  })

  it("keeps a configured token", () => {
    const config = load({
      ARTIFACT_HOST_URL: "http://host:4100",
      ARTIFACT_SIGNING_KEY: KEY,
      ARTIFACT_INTERNAL_TOKEN: "a".repeat(32),
    })
    expect(config.ARTIFACT_INTERNAL_TOKEN).toBe("a".repeat(32))
  })

  it("generates an ephemeral token for a development boot and says so", () => {
    const warnings: string[] = []
    const config = load(
      { ARTIFACT_HOST_URL: "http://host:4100", ARTIFACT_SIGNING_KEY: KEY },
      (message) => warnings.push(message),
    )
    expect(config.ARTIFACT_INTERNAL_TOKEN.length).toBeGreaterThanOrEqual(32)
    expect(warnings.join("\n")).toMatch(/ARTIFACT_INTERNAL_TOKEN is unset; generated/)
    expect(warnings.join("\n")).not.toContain(config.ARTIFACT_INTERNAL_TOKEN)
  })

  it("generates a different token per boot", () => {
    const overrides = { ARTIFACT_HOST_URL: "http://host:4100", ARTIFACT_SIGNING_KEY: KEY }
    expect(load(overrides).ARTIFACT_INTERNAL_TOKEN).not.toBe(load(overrides).ARTIFACT_INTERNAL_TOKEN)
  })

  it("refuses a short token", () => {
    expect(() =>
      load({
        ARTIFACT_HOST_URL: "http://host:4100",
        ARTIFACT_SIGNING_KEY: KEY,
        ARTIFACT_INTERNAL_TOKEN: "a".repeat(31),
      }),
    ).toThrow(/ARTIFACT_INTERNAL_TOKEN must be at least 32 characters/)
  })

  it("refuses a production boot with the surface configured and no token", () => {
    expect(() =>
      load({
        NODE_ENV: "production",
        AUTH_MODE: "basic",
        BACKEND_MODE: "live",
        OPENCODE_PASSWORD: "opencode-password",
        OPENCHAT_PASSWORD: "a-long-production-password",
        SESSION_SECRET: "production-secret-production-secret",
        ARTIFACT_HOST_URL: "https://artifacts.example.com",
        ARTIFACT_SIGNING_KEY: KEY,
      }),
    ).toThrow(
      /ARTIFACT_INTERNAL_TOKEN must be set when the artifact surface is configured and NODE_ENV=production/,
    )
  })

  it("accepts a production token", () => {
    const config = load({
      NODE_ENV: "production",
      AUTH_MODE: "basic",
      BACKEND_MODE: "live",
      OPENCODE_PASSWORD: "opencode-password",
      OPENCHAT_PASSWORD: "a-long-production-password",
      SESSION_SECRET: "production-secret-production-secret",
      ARTIFACT_HOST_URL: "https://artifacts.example.com",
      ARTIFACT_SIGNING_KEY: KEY,
      ARTIFACT_INTERNAL_TOKEN: "production-internal-token-0123456789",
    })
    expect(config.ARTIFACT_INTERNAL_TOKEN).toBe("production-internal-token-0123456789")
  })

  it("does not require a token while the surface is off, even in production", () => {
    const config = load({
      NODE_ENV: "production",
      AUTH_MODE: "basic",
      BACKEND_MODE: "live",
      OPENCODE_PASSWORD: "opencode-password",
      OPENCHAT_PASSWORD: "a-long-production-password",
      SESSION_SECRET: "production-secret-production-secret",
    })
    expect(config.ARTIFACT_INTERNAL_TOKEN).toBe("")
  })
})

describe("artifact environment validation", () => {
  it("refuses a signing key below 32 characters", () => {
    expect(() => load({ ARTIFACT_SIGNING_KEY: "a".repeat(31) })).toThrow(
      /ARTIFACT_SIGNING_KEY must be at least 32 characters/,
    )
    expect(() => load({ ARTIFACT_SIGNING_KEY: "a".repeat(32) })).not.toThrow()
  })

  it.each([
    ["a relative URL", "artifacts.example.com"],
    ["a non-http scheme", "ftp://artifacts.example.com"],
    ["embedded credentials", "https://user:pass@artifacts.example.com"],
    ["a query", "https://artifacts.example.com/?a=1"],
    ["a fragment", "https://artifacts.example.com/#a"],
  ])("refuses %s", (_label, value) => {
    expect(() => load({ ARTIFACT_HOST_URL: value })).toThrow(/ARTIFACT_HOST_URL/)
  })

  it("refuses plain http in production", () => {
    expect(() =>
      load({
        NODE_ENV: "production",
        AUTH_MODE: "basic",
        BACKEND_MODE: "live",
        OPENCODE_PASSWORD: "opencode-password",
        ARTIFACT_HOST_URL: "http://artifacts.example.com",
        ARTIFACT_SIGNING_KEY: KEY,
      }),
    ).toThrow(/ARTIFACT_HOST_URL must use https when NODE_ENV=production/)
  })

  it("accepts a production https pair", () => {
    const config = load({
      NODE_ENV: "production",
      AUTH_MODE: "basic",
      BACKEND_MODE: "live",
      OPENCODE_PASSWORD: "opencode-password",
      OPENCHAT_PASSWORD: "a-long-production-password",
      SESSION_SECRET: "production-secret-production-secret",
      ARTIFACT_HOST_URL: "https://artifacts.example.com",
      ARTIFACT_SIGNING_KEY: KEY,
      ARTIFACT_INTERNAL_TOKEN: "production-internal-token-0123456789",
    })
    expect(config.ARTIFACT_HOST_URL).toBe("https://artifacts.example.com")
  })
})
