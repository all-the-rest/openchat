import type { ModelRef, TurnPolicy } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import type { PromptInput } from "@openchat/opencode"
import { describe, expect, it } from "vitest"

import type { EngineEvent, FallbackEngineDeps } from "../src/fallback-engine"
import { FallbackEngine } from "../src/fallback-engine"

const A: ModelRef = { providerID: "acme", modelID: "a" }
const B: ModelRef = { providerID: "acme", modelID: "b" }

function policy(): TurnPolicy {
  return {
    surface: "chat",
    chain: [A, B],
    paidDailyTurns: 10,
    contextSoftCap: 0,
  }
}

function makeDeps() {
  const calls: Array<{ sessionID: string; input: PromptInput }> = []
  const deps: FallbackEngineDeps = {
    backend: {
      async prompt(sessionID, input) {
        calls.push({ sessionID, input })
        return { messageID: `msg_${calls.length}` }
      },
    },
    ledger: {
      async record() {},
      async paidTurnsToday() {
        return 0
      },
    },
  }
  return { deps, calls }
}

function failureEvent(): EngineEvent {
  return {
    type: EVENT.executionFailed,
    data: {
      sessionID: "s1",
      messageID: "m1",
      message: "Rate limit reached",
      code: "rate_limit",
    },
  }
}

describe("fallback submissions", () => {
  it("keeps the older turn when two overlapping begins settle out of order", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)

    const first = engine.begin("s1", { text: "first" }, policy(), A)
    const second = engine.begin("s1", { text: "second" }, policy(), B)

    // The first submission's response arrives after the second begin. It must
    // not attach its id to the newer turn or drop the snapshot of the first.
    engine.adopt("s1", first, "msg_first")
    // The second submission turns out to be queued and is abandoned.
    engine.abandon("s1", second)

    const result = await engine.onFailure(failureEvent())
    expect(result.suppress).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input.text).toBe("first")
  })

  it("ignores a stale abandon that would otherwise drop the active turn", async () => {
    const { deps } = makeDeps()
    const engine = new FallbackEngine(deps)

    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.begin("s1", { text: "second" }, policy(), B)
    engine.abandon("s1", first)

    expect(engine.activeCount()).toBe(1)
    expect((await engine.onFailure(failureEvent())).suppress).toBe(true)
  })

  it("starts the retry without the original queued delivery", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi", delivery: "queue" }, policy(), A)

    await engine.onFailure(failureEvent())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toMatchObject({ text: "hi", modelRef: B })
    expect(calls[0]?.input).not.toHaveProperty("delivery")
  })
})
