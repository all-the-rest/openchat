import { describe, expect, it } from "vitest"
import {
  createScheduleRequestSchema,
  scheduleEndsMillis,
  scheduleEndsSchema,
} from "../src/tasks"

const valid = { prompt: "Summarise the weekly notes", ends: { after: "30 minutes" } }

describe("create schedule request", () => {
  it("accepts a one-shot duration and an instant", () => {
    expect(createScheduleRequestSchema.safeParse(valid).success).toBe(true)
    expect(
      createScheduleRequestSchema.safeParse({ prompt: "Run it", ends: { at: "2026-11-20T09:30" } })
        .success,
    ).toBe(true)
  })

  it("accepts an instant with an offset and seconds", () => {
    expect(
      scheduleEndsSchema.safeParse({ at: "2026-11-20T09:30:00Z" }).success,
    ).toBe(true)
  })

  it.each([
    ["missing prompt", { ends: { after: "5 minutes" } }],
    ["empty prompt", { prompt: "", ends: { after: "5 minutes" } }],
    ["overlong prompt", { prompt: "x".repeat(4001), ends: { after: "5 minutes" } }],
    ["missing ends", { prompt: "Run it" }],
    ["both ends", { prompt: "Run it", ends: { after: "5 minutes", at: "2026-11-20T09:30" } }],
    ["empty ends", { prompt: "Run it", ends: {} }],
    ["unknown duration unit", { prompt: "Run it", ends: { after: "5 fortnights" } }],
    ["zero duration", { prompt: "Run it", ends: { after: "0 minutes" } }],
    ["over-cap duration", { prompt: "Run it", ends: { after: "91 days" } }],
    ["over-cap weeks", { prompt: "Run it", ends: { after: "13 weeks" } }],
    ["malformed instant", { prompt: "Run it", ends: { at: "next tuesday" } }],
    ["out-of-range year", { prompt: "Run it", ends: { at: "1999-11-20T09:30" } }],
  ])("rejects %s", (_label, body) => {
    expect(createScheduleRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe("schedule end condition", () => {
  it("resolves a duration against the given clock", () => {
    expect(scheduleEndsMillis({ after: "15 minutes" }, 1_000)).toBe(1_000 + 15 * 60_000)
  })

  it("parses an instant", () => {
    expect(scheduleEndsMillis({ at: "2026-11-20T09:30:00Z" }, 0)).toBe(
      Date.parse("2026-11-20T09:30:00Z"),
    )
  })

  it("has no millis for an empty condition", () => {
    expect(scheduleEndsMillis({}, 1_000)).toBeUndefined()
  })
})
