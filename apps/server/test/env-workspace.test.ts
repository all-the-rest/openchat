import { describe, expect, it } from "vitest"
import {
  CHAT_FILE_BODY_CEILING_BYTES,
  CHAT_FILE_MAX_BYTES,
  CHAT_QUOTA_PER_CHAT_BYTES,
  CHAT_QUOTA_TOTAL_BYTES,
} from "@openchat/contracts"
import { loadWorkspaceEnv } from "../src/env-workspace"

function load(source: Record<string, string | undefined>) {
  const warnings: string[] = []
  const value = loadWorkspaceEnv(source, (message) => warnings.push(message))
  return { value, warnings }
}

describe("workspace file env", () => {
  it("uses the documented defaults when nothing is set", () => {
    const { value, warnings } = load({})
    expect(value).toEqual({
      WORKSPACE_QUOTA_PER_CHAT_BYTES: CHAT_QUOTA_PER_CHAT_BYTES,
      WORKSPACE_QUOTA_TOTAL_BYTES: CHAT_QUOTA_TOTAL_BYTES,
      WORKSPACE_MAX_FILE_BYTES: CHAT_FILE_MAX_BYTES,
    })
    expect(CHAT_QUOTA_PER_CHAT_BYTES).toBe(100 * 1024 * 1024)
    expect(CHAT_QUOTA_TOTAL_BYTES).toBe(1024 * 1024 * 1024)
    expect(CHAT_FILE_MAX_BYTES).toBe(20 * 1024 * 1024)
    expect(warnings).toEqual([])
  })

  it("accepts explicit values", () => {
    const { value, warnings } = load({
      WORKSPACE_QUOTA_PER_CHAT_BYTES: "1000",
      WORKSPACE_QUOTA_TOTAL_BYTES: "5000",
      WORKSPACE_MAX_FILE_BYTES: "500",
    })
    expect(value).toEqual({
      WORKSPACE_QUOTA_PER_CHAT_BYTES: 1000,
      WORKSPACE_QUOTA_TOTAL_BYTES: 5000,
      WORKSPACE_MAX_FILE_BYTES: 500,
    })
    expect(warnings).toEqual([])
  })

  it.each(["0", "-1", "1.5", "many"])("falls back with a warning for %s", (raw) => {
    const { value, warnings } = load({ WORKSPACE_QUOTA_PER_CHAT_BYTES: raw })
    expect(value.WORKSPACE_QUOTA_PER_CHAT_BYTES).toBe(CHAT_QUOTA_PER_CHAT_BYTES)
    expect(warnings).toEqual([
      "WORKSPACE_QUOTA_PER_CHAT_BYTES must be a positive integer; using the default",
    ])
  })

  it("clamps the single-file cap to the body ceiling", () => {
    const { value, warnings } = load({ WORKSPACE_MAX_FILE_BYTES: "999999999999" })
    expect(value.WORKSPACE_MAX_FILE_BYTES).toBe(CHAT_FILE_BODY_CEILING_BYTES)
    expect(warnings).toEqual([
      "WORKSPACE_MAX_FILE_BYTES is above the 100 MiB ceiling; using the ceiling",
    ])
  })

  it("warns when one chat may hold more than the whole workspace", () => {
    const { value, warnings } = load({
      WORKSPACE_QUOTA_PER_CHAT_BYTES: "2000",
      WORKSPACE_QUOTA_TOTAL_BYTES: "1000",
    })
    expect(value.WORKSPACE_QUOTA_PER_CHAT_BYTES).toBe(2000)
    expect(warnings).toEqual([
      "WORKSPACE_QUOTA_PER_CHAT_BYTES is above WORKSPACE_QUOTA_TOTAL_BYTES; " +
        "the workspace quota will reject writes first",
    ])
  })
})
