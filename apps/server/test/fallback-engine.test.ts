import type { ModelRef, TurnPolicy } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import type { PromptInput } from "@openchat/opencode"
import { describe, expect, it } from "vitest"

import type { EngineEvent, FallbackEngineDeps } from "../src/fallback-engine"
import { FallbackEngine } from "../src/fallback-engine"

const A: ModelRef = { providerID: "acme", modelID: "a" }
const B: ModelRef = { providerID: "acme", modelID: "b", variant: "think" }
const FREE: ModelRef = { providerID: "acme", modelID: "free", isFree: true }

function policy(overrides: Partial<TurnPolicy> = {}): TurnPolicy {
  return {
    surface: "chat",
    chain: [A, B],
    paidDailyCap: 1000,
    contextSoftCap: 0,
    ...overrides,
  }
}

interface DepsOptions {
  promptImpl?: (sessionID: string, input: PromptInput) => Promise<{ messageID: string }>
  spent?: number
  now?: number
}

function makeDeps(options: DepsOptions = {}) {
  const calls: Array<{ sessionID: string; input: PromptInput }> = []
  const recorded: Array<{
    providerID: string
    modelID: string
    turns: number
    costMicros: number
  }> = []
  const now = options.now ?? 1000
  const deps: FallbackEngineDeps = {
    backend: {
      async prompt(sessionID, input) {
        calls.push({ sessionID, input })
        if (options.promptImpl) return options.promptImpl(sessionID, input)
        return { messageID: `msg_${calls.length}` }
      },
    },
    ledger: {
      async record(entry) {
        recorded.push(entry)
      },
      async spentToday() {
        return options.spent ?? 0
      },
    },
    now: () => now,
  }
  return { deps, calls, recorded, now }
}

function failureEvent(data: Record<string, unknown> = {}): EngineEvent {
  return {
    type: EVENT.executionFailed,
    data: {
      sessionID: "s1",
      messageID: "m1",
      message: "Rate limit reached",
      code: "rate_limit",
      ...data,
    },
  }
}

function textEvent(delta: string, sessionID = "s1"): EngineEvent {
  return {
    type: EVENT.textDelta,
    data: { sessionID, messageID: "m1", partID: "p1", delta },
  }
}

function successEvent(data: Record<string, unknown> = {}): EngineEvent {
  return {
    type: EVENT.executionSucceeded,
    data: { sessionID: "s1", messageID: "m1", ...data },
  }
}

describe("FallbackEngine", () => {
  it("falls back on a retryable failure without text: suppress, notice, re-prompt and one outcome on success", async () => {
    const { deps, calls, now } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A, "m0")

    const result = await engine.onFailure(failureEvent())

    expect(result.suppress).toBe(true)
    expect(result.events).toHaveLength(1)
    const [notice] = result.events as [EngineEvent]
    expect(notice.type).toBe(EVENT.fallbackNotice)
    expect(notice).toMatchObject({
      id: expect.stringContaining("fb_"),
      created: now,
    })
    expect(notice.data).toMatchObject({
      sessionID: "s1",
      messageID: "msg_1",
      from: A,
      to: B,
      reason: "rate_limit",
      attempts: 1,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionID).toBe("s1")
    expect(calls[0]!.input.modelRef).toEqual(B)
    expect(calls[0]!.input.text).toBe("hi")

    // The outcome is emitted once, on completion, with the real answer.
    const outcomes = await engine.onSuccess(successEvent())
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.type).toBe(EVENT.turnOutcome)
    expect(outcomes[0]!.data).toMatchObject({
      sessionID: "s1",
      requested: A,
      answered: B,
      fellBack: true,
      reason: "rate_limit",
      attempts: 1,
    })
  })

  it("does not fall back after the attempt emitted any text", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A)
    engine.observe(textEvent("partial answer"))

    const result = await engine.onFailure(failureEvent())

    expect(result).toEqual({ suppress: false, events: [] })
    expect(calls).toHaveLength(0)
  })

  it("ignores deltas from other sessions but counts reasoning/tool output as emitted", async () => {
    const { deps } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A)
    engine.observe(textEvent("noise", "s2"))
    // Reasoning already shown to the owner is output: a later failure must
    // not silently re-run the turn with a different model.
    engine.observe({ type: EVENT.reasoningDelta, data: { sessionID: "s1", delta: "noise" } })

    const result = await engine.onFailure(failureEvent())

    expect(result.suppress).toBe(false)
  })

  it("does not fall back on the second attempt", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A)

    const first = await engine.onFailure(failureEvent())
    const second = await engine.onFailure(failureEvent())

    expect(first.suppress).toBe(true)
    expect(second).toEqual({ suppress: false, events: [] })
    expect(calls).toHaveLength(1)
  })

  const capCases: Array<[string, ModelRef[], number, boolean]> = [
    ["paid next with the cap exhausted", [A, B], 100, false],
    ["paid next with budget left", [A, B], 101, true],
    ["free next with the cap exhausted", [A, FREE], 100, true],
  ]
  it.each(capCases)("cap decision: %s", async (_name, chain, cap, expected) => {
    const { deps } = makeDeps({ spent: 100 })
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy({ chain, paidDailyCap: cap }), A)
    const result = await engine.onFailure(failureEvent())
    expect(result.suppress).toBe(expected)
  })

  it.each(["auth", "401", "403", "not_a_real_code"])(
    "never falls back for reason %s (even when retryable)",
    async (code) => {
      const { deps, calls } = makeDeps()
      const engine = new FallbackEngine(deps)
      engine.begin("s1", { text: "hi" }, policy(), A)
      const result = await engine.onFailure(
        failureEvent({ code, retryable: true, message: "an unspecified problem occurred" }),
      )
      expect(result).toEqual({ suppress: false, events: [] })
      expect(calls).toHaveLength(0)
    },
  )

  it("records the ledger and emits an outcome on success, then forgets the session", async () => {
    const { deps, recorded } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A, "m0")

    const events = await engine.onSuccess(successEvent())

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe(EVENT.turnOutcome)
    expect(events[0]!.data).toMatchObject({
      sessionID: "s1",
      requested: A,
      answered: A,
      fellBack: false,
      attempts: 0,
      costMicros: 0,
    })
    expect(recorded).toEqual([
      { providerID: A.providerID, modelID: A.modelID, turns: 1, costMicros: 0 },
    ])
    expect(engine.activeCount()).toBe(0)
  })

  it("records the answered fallback model and reports fellBack on success", async () => {
    const { deps, recorded } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A)
    await engine.onFailure(failureEvent())

    const events = await engine.onSuccess(successEvent())

    expect(events[0]!.data).toMatchObject({
      requested: A,
      answered: B,
      fellBack: true,
      attempts: 1,
    })
    expect(recorded).toEqual([
      { providerID: B.providerID, modelID: B.modelID, turns: 1, costMicros: 0 },
    ])
  })

  it("forwards an untracked session's failure unchanged", async () => {
    const { deps } = makeDeps()
    const engine = new FallbackEngine(deps)

    const result = await engine.onFailure(failureEvent({ sessionID: "unknown" }))

    expect(result).toEqual({ suppress: false, events: [] })
  })

  it("forwards the original failure when the re-prompt throws", async () => {
    const { deps, calls } = makeDeps({
      promptImpl: async () => {
        throw new Error("prompt down")
      },
    })
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A)

    const result = await engine.onFailure(failureEvent())

    expect(result).toEqual({ suppress: false, events: [] })
    expect(calls).toHaveLength(1)
  })

  it("forgets a session on request", async () => {
    const { deps } = makeDeps()
    const engine = new FallbackEngine(deps)
    engine.begin("s1", { text: "hi" }, policy(), A)
    expect(engine.activeCount()).toBe(1)
    engine.forget("s1")
    expect(engine.activeCount()).toBe(0)
    expect(await engine.onFailure(failureEvent())).toEqual({ suppress: false, events: [] })
  })

  it("bounds tracked sessions to 512 entries, evicting the oldest", async () => {
    const { deps } = makeDeps()
    const engine = new FallbackEngine(deps)
    for (let i = 0; i < 513; i += 1) {
      engine.begin(`s${i}`, { text: "hi" }, policy(), A)
    }

    expect(engine.activeCount()).toBe(512)
    expect(await engine.onFailure(failureEvent({ sessionID: "s0" }))).toEqual({
      suppress: false,
      events: [],
    })
    const newest = await engine.onFailure(failureEvent({ sessionID: "s512" }))
    expect(newest.suppress).toBe(true)
  })
})
