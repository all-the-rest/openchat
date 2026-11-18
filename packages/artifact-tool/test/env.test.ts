import { describe, expect, it } from "vitest"
import { loadToolEnv } from "../src/env"

const TOKEN = "test-internal-token-0123456789abcdef"

describe("tool environment", () => {
  it("defaults the BFF URL and keeps the token", () => {
    expect(loadToolEnv({ source: { ARTIFACT_INTERNAL_TOKEN: TOKEN } })).toEqual({
      bffUrl: "http://127.0.0.1:8787",
      token: TOKEN,
    })
  })

  it("drops a trailing slash and keeps a path prefix", () => {
    const env = loadToolEnv({
      source: {
        OPENCHAT_BFF_URL: "https://chat.example.com/bff/",
        ARTIFACT_INTERNAL_TOKEN: TOKEN,
      },
    })
    expect(env.bffUrl).toBe("https://chat.example.com/bff")
  })

  it("refuses a missing token and names the variable only", () => {
    expect(() => loadToolEnv({ source: {} })).toThrow(/ARTIFACT_INTERNAL_TOKEN must be set/)
    expect(() => loadToolEnv({ source: { ARTIFACT_INTERNAL_TOKEN: "   " } })).toThrow(
      /ARTIFACT_INTERNAL_TOKEN must be set/,
    )
  })

  it.each([
    ["a relative URL", "chat.example.com"],
    ["a non-http scheme", "ftp://chat.example.com"],
    ["embedded credentials", "https://user:pass@chat.example.com"],
    ["a query", "https://chat.example.com/?a=1"],
    ["a fragment", "https://chat.example.com/#a"],
  ])("refuses %s", (_label, value) => {
    expect(() =>
      loadToolEnv({ source: { OPENCHAT_BFF_URL: value, ARTIFACT_INTERNAL_TOKEN: TOKEN } }),
    ).toThrow(/OPENCHAT_BFF_URL/)
  })

  it("never puts the token in a refusal", () => {
    try {
      loadToolEnv({ source: { OPENCHAT_BFF_URL: "ftp://x", ARTIFACT_INTERNAL_TOKEN: `secret-${TOKEN}` } })
      throw new Error("expected a refusal")
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN)
    }
  })
})
