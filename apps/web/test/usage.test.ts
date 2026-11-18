import { EVENT } from "@openchat/contracts"
import type { EventEnvelope } from "@openchat/contracts"
import { describe, expect, it } from "vitest"
import {
  contextFill,
  readUsage,
  usageFromEvent,
  usageView,
} from "../src/chat/usage"

function event(type: string, data: Record<string, unknown>): EventEnvelope {
  return { id: "evt_1", created: 1, type, data }
}

describe("reported usage", () => {
  it("renders only the numbers the host reported", () => {
    const view = usageView({ input: 1200, output: 340, cached: 512 }, 128_000)
    expect(view).toEqual({
      reported: true,
      input: 1200,
      output: 340,
      cached: 512,
      contextLimit: 128_000,
    })
  })

  it("shows the unknown state when nothing was reported", () => {
    for (const report of [null, undefined, { input: 0, output: 0 }]) {
      const view = usageView(report, 128_000)
      expect(view).toEqual({
        reported: false,
        input: null,
        output: null,
        cached: null,
        contextLimit: null,
      })
      expect(contextFill(view)).toBeNull()
    }
  })

  it("does not claim a context limit the model catalogue lacks", () => {
    const view = usageView({ input: 10, output: 2 })
    expect(view.reported).toBe(true)
    expect(view.contextLimit).toBeNull()
    expect(contextFill(view)).toBeNull()
  })

  it("accepts the host's nested token shape and the live event", () => {
    expect(
      readUsage({
        input: 10,
        output: 5,
        reasoning: 2,
        cache: { read: 7, write: 3 },
      }),
    ).toEqual({ input: 10, output: 5, cached: 7 })

    expect(
      usageFromEvent(
        event(EVENT.usageUpdated, {
          sessionID: "ses_1",
          cost: 0,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
        }),
      ),
    ).toEqual({ input: 10, output: 5 })

    expect(usageFromEvent(event(EVENT.usageUpdated, { usage: { input: 3, output: 4 } }))).toEqual(
      { input: 3, output: 4 },
    )
    expect(usageFromEvent(event(EVENT.textDelta, { usage: { input: 3, output: 4 } }))).toBeNull()
  })

  it("rejects negative and non-finite counters instead of displaying them", () => {
    expect(readUsage({ input: -1, output: 4 })).toBeNull()
    expect(readUsage({ input: Number.POSITIVE_INFINITY, output: 4 })).toBeNull()
    expect(readUsage({ input: "10", output: true })).toBeNull()
    expect(readUsage({ input: 10, output: 4, cached: -2 })).toEqual({ input: 10, output: 4 })
  })

  it("derives the context fill only from reported values", () => {
    const fill = contextFill(usageView({ input: 64_000, output: 0 }, 128_000))
    expect(fill).toEqual({ used: 64_000, limit: 128_000, ratio: 0.5 })

    const over = contextFill(usageView({ input: 200_000, output: 0 }, 128_000))
    expect(over?.ratio).toBe(1)
  })
})
