import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_MEMORY_DATA_DIR } from "../src/env-memory"
import { loadEnv } from "../src/env"
import type { EnvConfig } from "../src/env"

const TOKEN = "test-memory-token-0123456789abcdef"

function load(
  overrides: Record<string, string | undefined> = {},
  warn: (message: string) => void = () => {},
): EnvConfig {
  return loadEnv({
    source: {
      WORKSPACE_DIR: "/workspace",
      OPENCHAT_PASSWORD: "secret-password",
      SESSION_SECRET: "test-secret-test-secret-test-secret",
      ...overrides,
    },
    warn,
  })
}

/** A production boot needs the credential and session halves set as well. */
function production(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    AUTH_MODE: "basic",
    BACKEND_MODE: "live",
    OPENCODE_PASSWORD: "opencode-password",
    OPENCHAT_PASSWORD: "a-long-production-password",
    SESSION_SECRET: "production-secret-production-secret",
    ...overrides,
  }
}

describe("memory environment defaults", () => {
  it("stores under the default workspace directory", () => {
    expect(load().MEMORY_DATA_DIR).toBe(DEFAULT_MEMORY_DATA_DIR)
    expect(DEFAULT_MEMORY_DATA_DIR).toBe(join("/workspace", ".memory"))
  })

  it("honours an explicit directory", () => {
    expect(load({ MEMORY_DATA_DIR: "/srv/memory" }).MEMORY_DATA_DIR).toBe("/srv/memory")
  })

  it("trims and normalises a directory", () => {
    expect(load({ MEMORY_DATA_DIR: "  /srv/memory/  " }).MEMORY_DATA_DIR).toBe("/srv/memory")
  })
})

describe("memory environment: data directory validation", () => {
  it.each([
    ["a relative path", "memory"],
    ["a dot path", "./memory"],
    ["a parent traversal", "/workspace/../etc"],
    ["a mid-path traversal", "/srv/a/../b"],
    ["a backslash traversal", "/srv/a\\..\\b"],
  ])("refuses %s", (_label, value) => {
    expect(() => load({ MEMORY_DATA_DIR: value })).toThrow(/MEMORY_DATA_DIR/)
  })

  it("refuses a null byte", () => {
    expect(() => load({ MEMORY_DATA_DIR: "/srv/mem\0ory" })).toThrow(/MEMORY_DATA_DIR/)
  })
})

describe("memory environment: internal token", () => {
  it("generates an ephemeral token for a development boot and says so", () => {
    const warnings: string[] = []
    const config = load({}, (message) => warnings.push(message))
    expect(config.MEMORY_INTERNAL_TOKEN.length).toBeGreaterThanOrEqual(32)
    expect(warnings.join("\n")).toMatch(/MEMORY_INTERNAL_TOKEN is unset; generated/)
    expect(warnings.join("\n")).not.toContain(config.MEMORY_INTERNAL_TOKEN)
  })

  it("generates a different token per boot", () => {
    expect(load().MEMORY_INTERNAL_TOKEN).not.toBe(load().MEMORY_INTERNAL_TOKEN)
  })

  it("keeps a configured token", () => {
    expect(load({ MEMORY_INTERNAL_TOKEN: TOKEN }).MEMORY_INTERNAL_TOKEN).toBe(TOKEN)
  })

  it("refuses a short token", () => {
    expect(() => load({ MEMORY_INTERNAL_TOKEN: "a".repeat(31) })).toThrow(
      /MEMORY_INTERNAL_TOKEN must be at least 32 characters/,
    )
    expect(() => load({ MEMORY_INTERNAL_TOKEN: "a".repeat(32) })).not.toThrow()
  })

  it("refuses a production boot without a token", () => {
    expect(() => load(production())).toThrow(
      /MEMORY_INTERNAL_TOKEN must be set when NODE_ENV=production/,
    )
  })

  it("accepts a production token", () => {
    const config = load(production({ MEMORY_INTERNAL_TOKEN: TOKEN }))
    expect(config.MEMORY_INTERNAL_TOKEN).toBe(TOKEN)
  })
})
