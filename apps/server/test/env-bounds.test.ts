import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/env"

/**
 * Bounds on the BFF's own listener and its Code status probe. Split from
 * `env.test.ts` to keep both files well under the 400-line ceiling.
 */

function env(overrides: Record<string, string>, warnings: string[] = []) {
  return loadEnv({ source: overrides, warn: (message) => warnings.push(message) })
}

describe("BFF env bounds", () => {
  it("rejects a PORT outside 1..65535 and keeps the boundary value", () => {
    const warnings: string[] = []
    expect(env({ PORT: "0" }, warnings).PORT).toBe(8787)
    expect(env({ PORT: "99999" }, warnings).PORT).toBe(8787)
    expect(env({ PORT: "65535" }).PORT).toBe(65_535)
    const text = warnings.join("\n")
    expect(text).toContain("PORT")
    expect(text).not.toContain("99999")
  })

  it("clamps CODE_STATUS_TIMEOUT_MS to 100..10000 ms", () => {
    const warnings: string[] = []
    expect(env({ CODE_STATUS_TIMEOUT_MS: "20" }, warnings).CODE_STATUS_TIMEOUT_MS).toBe(100)
    expect(
      env({ CODE_STATUS_TIMEOUT_MS: "3600000" }, warnings).CODE_STATUS_TIMEOUT_MS,
    ).toBe(10_000)
    expect(env({ CODE_STATUS_TIMEOUT_MS: "100" }).CODE_STATUS_TIMEOUT_MS).toBe(100)
    expect(env({ CODE_STATUS_TIMEOUT_MS: "10000" }).CODE_STATUS_TIMEOUT_MS).toBe(10_000)
    const text = warnings.join("\n")
    expect(text).toContain("CODE_STATUS_TIMEOUT_MS")
    expect(text).not.toContain("3600000")
  })
})
