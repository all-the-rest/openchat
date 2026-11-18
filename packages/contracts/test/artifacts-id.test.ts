import { describe, expect, it } from "vitest"
import { ARTIFACT_DOCUMENT_FILE, ARTIFACT_META_FILE, isArtifactId } from "../src/artifacts/id"

describe("artifact id and layout contract", () => {
  it("accepts exactly 64 lower-case hex characters", () => {
    expect(isArtifactId("a".repeat(64))).toBe(true)
    expect(isArtifactId("0123456789abcdef".repeat(4))).toBe(true)
  })

  it.each([
    ["uppercase", "A".repeat(64)],
    ["short", "a".repeat(63)],
    ["long", "a".repeat(65)],
    ["traversal", `${"a".repeat(62)}/..`],
    ["absolute", `/${"a".repeat(63)}`],
    ["empty", ""],
  ])("rejects an unshaped id: %s", (_label, id) => {
    expect(isArtifactId(id)).toBe(false)
  })

  it("names the one document file and the BFF-only sidecar", () => {
    expect(ARTIFACT_DOCUMENT_FILE).toBe("index.html")
    expect(ARTIFACT_META_FILE).toBe("meta.json")
  })
})
