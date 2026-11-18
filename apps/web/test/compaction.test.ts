import { describe, expect, it } from "vitest"
import type { EventEnvelope, TokenUsage } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import { applyCompactionEvent, dropCompaction } from "../src/chat/compaction"
import { contextFill, lastMessageUsage, readTokenUsage } from "../src/chat/context-fill"

const usage: TokenUsage = {
  input: 1_000,
  output: 200,
  reasoning: 50,
  cache: { read: 500, write: 100 },
}

function event(type: string, data: Record<string, unknown>): EventEnvelope {
  return { id: `evt_${type}`, created: 1, type, data }
}

describe("context fill arithmetic", () => {
  it("counts prompt tokens (input plus cache) against the window", () => {
    expect(contextFill(usage, 10_000)).toEqual({ used: 1_600, limit: 10_000, percent: 16 })
    expect(contextFill({ ...usage, input: 1, cache: { read: 0, write: 0 } }, 10_000)).toEqual({
      used: 1,
      limit: 10_000,
      percent: 0,
    })
  })

  it("clamps an overrun at 100 percent without hiding the used count", () => {
    expect(contextFill({ ...usage, input: 20_000, cache: { read: 0, write: 0 } }, 10_000)).toEqual(
      { used: 20_000, limit: 10_000, percent: 100 },
    )
  })

  it("stays neutral without usage or without a window", () => {
    expect(contextFill(null, 10_000)).toBeNull()
    expect(contextFill(usage, null)).toBeNull()
    expect(contextFill(usage, 0)).toBeNull()
    expect(contextFill(usage, Number.NaN)).toBeNull()
  })

  it("reads only a complete usage payload", () => {
    expect(readTokenUsage(usage)).toEqual(usage)
    expect(readTokenUsage(null)).toBeNull()
    expect(readTokenUsage({ input: 1 })).toBeNull()
    expect(readTokenUsage({ ...usage, cache: { read: "x", write: 1 } })).toBeNull()
  })

  it("restores the last usage from a session read", () => {
    expect(
      lastMessageUsage([
        {
          id: "m1",
          sessionID: "s",
          role: "assistant",
          parts: [],
          created: 1,
          status: "complete",
          usage,
        },
      ]),
    ).toEqual(usage)
    expect(lastMessageUsage([])).toBeNull()
  })
})

describe("compaction event fold", () => {
  it("pairs started and ended and keeps the summary", () => {
    const started = applyCompactionEvent(
      [],
      event(EVENT.compactionStarted, { sessionID: "s", reason: "auto" }),
    )
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ status: "started", reason: "auto" })

    const ended = applyCompactionEvent(
      started,
      event(EVENT.compactionEnded, { sessionID: "s", reason: "auto", text: "Summary" }),
    )
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ status: "ended", summary: "Summary" })
  })

  it("marks the open section failed with the host reason", () => {
    const started = applyCompactionEvent(
      [],
      event(EVENT.compactionStarted, { sessionID: "s", reason: "manual" }),
    )
    const failed = applyCompactionEvent(
      started,
      event(EVENT.compactionFailed, {
        sessionID: "s",
        reason: "manual",
        error: { type: "x", message: "No model" },
      }),
    )
    expect(failed[0]).toMatchObject({ status: "failed", error: "No model" })
  })

  it("adds a terminal section when the start event was missed", () => {
    const ended = applyCompactionEvent(
      [],
      event(EVENT.compactionEnded, { sessionID: "s", reason: "auto", text: "Only end" }),
    )
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ status: "ended", summary: "Only end" })
  })

  it("ignores events without a session and drops a retried section", () => {
    const started = applyCompactionEvent(
      [],
      event(EVENT.compactionStarted, { sessionID: "s", reason: "auto" }),
    )
    expect(applyCompactionEvent(started, event(EVENT.compactionStarted, { reason: "auto" }))).toBe(
      started,
    )
    const id = started[0]?.id ?? ""
    expect(dropCompaction(started, id)).toEqual([])
    expect(dropCompaction(started, "missing")).toBe(started)
  })
})
