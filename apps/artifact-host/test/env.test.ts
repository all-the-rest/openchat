import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/env"
import { KEY } from "./helpers"

function load(
  overrides: Record<string, string | undefined> = {},
  warn: (message: string) => void = () => {},
) {
  return loadEnv({ source: { ARTIFACT_SIGNING_KEY: KEY, ...overrides }, warn })
}

describe("artifact host environment", () => {
  it("defaults to loopback, port 4100 and the Vite dev origin", () => {
    const config = load()
    expect(config.HOST).toBe("127.0.0.1")
    expect(config.PORT).toBe(4100)
    expect(config.ARTIFACT_FRAME_ANCESTORS).toBe("http://localhost:5173")
    expect(config.ARTIFACTS_DIR).toBe(join(process.cwd(), ".openchat-artifacts"))
  })

  it("accepts explicit values and resolves the directory", () => {
    const config = load({
      HOST: "0.0.0.0",
      PORT: "4200",
      ARTIFACT_FRAME_ANCESTORS: "https://chat.example.com",
      ARTIFACTS_DIR: "/srv/artifacts",
    })
    expect(config.HOST).toBe("0.0.0.0")
    expect(config.PORT).toBe(4200)
    expect(config.ARTIFACT_FRAME_ANCESTORS).toBe("https://chat.example.com")
    expect(config.ARTIFACTS_DIR).toBe("/srv/artifacts")
  })

  it("refuses to boot without a signing key", () => {
    expect(() => load({ ARTIFACT_SIGNING_KEY: undefined })).toThrow(
      "ARTIFACT_SIGNING_KEY must be set",
    )
    expect(() => load({ ARTIFACT_SIGNING_KEY: "   " })).toThrow(
      "ARTIFACT_SIGNING_KEY must be set",
    )
  })

  it("refuses a signing key below 32 characters", () => {
    expect(() => load({ ARTIFACT_SIGNING_KEY: "a".repeat(31) })).toThrow(
      "ARTIFACT_SIGNING_KEY must be at least 32 characters",
    )
    expect(() => load({ ARTIFACT_SIGNING_KEY: "a".repeat(32) })).not.toThrow()
  })

  it.each([
    ["a directive separator", "https://chat.example.com; script-src *"],
    ["a control byte", "https://chat.example.com\nX: y"],
  ])("refuses frame ancestors with %s", (_label, value) => {
    expect(() => load({ ARTIFACT_FRAME_ANCESTORS: value })).toThrow(
      /ARTIFACT_FRAME_ANCESTORS/,
    )
  })

  it("warns and falls back on an invalid port", () => {
    const warnings: string[] = []
    const config = load({ PORT: "70000" }, (message) => warnings.push(message))
    expect(config.PORT).toBe(4100)
    expect(warnings.join("\n")).toContain("PORT must be an integer between 1 and 65535")
  })

  it("never puts the key in a warning", () => {
    const warnings: string[] = []
    load({ PORT: "abc" }, (message) => warnings.push(message))
    expect(warnings.join("\n")).not.toContain(KEY)
  })
})
