import type { ModelRef, TurnPolicy } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import type { PromptInput } from "@openchat/opencode"
import { describe, expect, it, vi } from "vitest"

import type { EngineEvent, FallbackEngineDeps } from "../src/fallback-engine"
import { FallbackEngine } from "../src/fallback-engine"

const A: ModelRef = { providerID: "acme", modelID: "a" }
const B: ModelRef = { providerID: "acme", modelID: "b" }

function policy(): TurnPolicy {
  return { surface: "chat", chain: [A, B], paidDailyTurns: 10, contextSoftCap: 0 }
}

function makeDeps(options: { recordImpl?: () => Promise<void>; warn?: (m: string) => void } = {}) {
  const calls: Array<{ sessionID: string; input: PromptInput }> = []
  const recorded: Array<{ providerID: string; modelID: string }> = []
  const deps: FallbackEngineDeps = {
    backend: {
      async prompt(sessionID, input) {
        calls.push({ sessionID, input })
        return { messageID: `msg_${calls.length}` }
      },
    },
    ledger: {
      async record(entry) {
        if (options.recordImpl) return options.recordImpl()
        recorded.push({ providerID: entry.providerID, modelID: entry.modelID })
      },
      async paidTurnsToday() {
        return 0
      },
    },
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  }
  return { deps, calls, recorded }
}

function successEvent(messageID: string, sessionID = "s1"): EngineEvent {
  return { type: EVENT.executionSucceeded, data: { sessionID, messageID } }
}

function failureEvent(messageID: string, sessionID = "s1"): EngineEvent {
  return {
    type: EVENT.executionFailed,
    data: { sessionID, messageID, message: "Rate limit reached", code: "rate_limit" },
  }
}

/** Live host shape: terminal events carry only `sessionID`. */
function liveSuccess(sessionID = "s1"): EngineEvent {
  return { type: EVENT.executionSucceeded, data: { sessionID } }
}

function liveFailure(sessionID = "s1"): EngineEvent {
  return {
    type: EVENT.executionFailed,
    data: { sessionID, message: "Rate limit reached", code: "rate_limit" },
  }
}

function deltaEvent(messageID: string, delta = "late output", sessionID = "s1"): EngineEvent {
  return {
    type: EVENT.textDelta,
    data: { sessionID, messageID, partID: "p1", delta },
  }
}

describe("fallback terminal ownership", () => {
  it("credits a superseded turn's success to its message and keeps the newer turn", async () => {
    const { deps, recorded } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")
    const second = engine.begin("s1", { text: "second" }, policy(), B)

    // A's completion arrives while B's POST is still open. It belongs to A.
    const firstOutcome = await engine.onSuccess(successEvent("msg_a"))
    expect(firstOutcome[0]!.data).toMatchObject({ requested: A, answered: A, attempts: 1 })
    expect(recorded).toEqual([{ providerID: A.providerID, modelID: A.modelID }])
    // The newer registration survives A's outcome.
    expect(engine.activeCount()).toBe(1)

    // B has its own message id and is recorded separately, not absorbed by A.
    engine.adopt("s1", second, "msg_b")
    const secondOutcome = await engine.onSuccess(successEvent("msg_b"))
    expect(secondOutcome[0]!.data).toMatchObject({ requested: B, answered: B, attempts: 1 })
    expect(recorded[1]).toEqual({ providerID: B.providerID, modelID: B.modelID })
    expect(engine.activeCount()).toBe(0)
  })

  it("never retries a superseded turn with the newer payload", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")
    const second = engine.begin("s1", { text: "second" }, policy(), B)
    engine.adopt("s1", second, "msg_b")

    const result = await engine.onFailure(failureEvent("msg_a"))

    expect(result).toEqual({ suppress: false, events: [] })
    expect(calls).toHaveLength(0)
    // Only A's stale state was dropped; B keeps its registration.
    expect(engine.activeCount()).toBe(1)
    const outcome = await engine.onSuccess(successEvent("msg_b"))
    expect(outcome[0]!.data).toMatchObject({ requested: B, answered: B, attempts: 1 })
  })

  it("drops the previous message id when a retry adopts a new one", async () => {
    const { deps, recorded } = makeDeps()
    const engine = new FallbackEngine(deps)
    const token = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", token, "msg_old")

    const retry = await engine.onFailure(failureEvent("msg_old"))
    expect(retry.suppress).toBe(true)
    expect(recorded).toHaveLength(0)

    // The old id belonged to the failed attempt. A late completion for it must
    // not resolve to the retried turn and be counted twice.
    expect(await engine.onSuccess(successEvent("msg_old"))).toEqual([])
    expect(recorded).toHaveLength(0)

    const outcome = await engine.onSuccess(successEvent("msg_1"))
    expect(outcome[0]!.data).toMatchObject({ requested: A, answered: B, attempts: 2 })
    expect(recorded).toEqual([{ providerID: B.providerID, modelID: B.modelID }])
  })

  it("attributes live-shaped successes in submission order", async () => {
    const { deps, recorded } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")
    engine.begin("s1", { text: "second" }, policy(), B)

    // The live host sends no message id. The oldest awaiting turn is A.
    const firstOutcome = await engine.onSuccess(liveSuccess())
    expect(firstOutcome[0]!.data).toMatchObject({ requested: A, answered: A, attempts: 1 })
    expect(recorded).toEqual([{ providerID: A.providerID, modelID: A.modelID }])
    expect(engine.activeCount()).toBe(1)

    const secondOutcome = await engine.onSuccess(liveSuccess())
    expect(secondOutcome[0]!.data).toMatchObject({ requested: B, answered: B, attempts: 1 })
    expect(recorded[1]).toEqual({ providerID: B.providerID, modelID: B.modelID })
    expect(engine.activeCount()).toBe(0)
  })

  it("forwards a live-shaped superseded failure without retrying the newer payload", async () => {
    const { deps, calls, recorded } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")
    engine.begin("s1", { text: "second" }, policy(), B)

    const result = await engine.onFailure(liveFailure())

    expect(result).toEqual({ suppress: false, events: [] })
    expect(calls).toHaveLength(0)
    // Only A's stale state was dropped; B keeps its registration and answer.
    expect(engine.activeCount()).toBe(1)
    const outcome = await engine.onSuccess(liveSuccess())
    expect(outcome[0]!.data).toMatchObject({ requested: B, answered: B, attempts: 1 })
    expect(recorded).toEqual([{ providerID: B.providerID, modelID: B.modelID }])
  })

  it("credits a late delta to its own superseded turn instead of the newer one", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")
    const second = engine.begin("s1", { text: "second" }, policy(), B)
    engine.adopt("s1", second, "msg_b")

    // A is superseded, but the delta still belongs to it. It must not make B
    // look as if it had already emitted output.
    engine.observe(deltaEvent("msg_a"))
    const retry = await engine.onFailure(failureEvent("msg_b"))
    expect(retry.suppress).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input.text).toBe("second")

    // A's later failure is forwarded (superseded, never retried).
    expect(await engine.onFailure(failureEvent("msg_a"))).toEqual({
      suppress: false,
      events: [],
    })
    expect(calls).toHaveLength(1)
  })

  it("credits an unknown-id delta to the current turn before adoption", async () => {
    const { deps, calls, recorded } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")
    engine.begin("s1", { text: "second" }, policy(), B)

    // A finishes and leaves the FIFO; B's POST is still open with no id yet.
    await engine.onSuccess(successEvent("msg_a"))
    engine.observe(deltaEvent("msg_unknown", "partial answer"))

    // The unknown id was credited to B, so its failure cannot be retried.
    expect(await engine.onFailure(failureEvent("msg_unknown"))).toEqual({
      suppress: false,
      events: [],
    })
    expect(calls).toHaveLength(0)
    expect(recorded).toEqual([{ providerID: A.providerID, modelID: A.modelID }])
  })

  it("ignores a delta for a retired retry id", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")

    // The retry replaces msg_a and retires it.
    expect((await engine.onFailure(failureEvent("msg_a"))).suppress).toBe(true)
    expect(calls).toHaveLength(1)
    await engine.onSuccess(successEvent("msg_1"))

    // B is current and still un-adopted; a late delta for the retired id must
    // not be mistaken for B's output.
    engine.begin("s1", { text: "second" }, policy(), B)
    engine.observe(deltaEvent("msg_a"))
    const retry = await engine.onFailure(failureEvent("msg_unknown"))
    expect(retry.suppress).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.input.text).toBe("second")
  })

  it("closes the finishing turn before a slow ledger write so the next turn keeps its delta", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, calls } = makeDeps({ recordImpl: () => gate })
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "msg_a")

    const finishing = engine.onSuccess(successEvent("msg_a"))
    // The next turn is registered while the ledger write is still in flight and
    // produces output before its prompt response (and id) arrives.
    engine.begin("s1", { text: "second" }, policy(), B)
    engine.observe(deltaEvent("asst_b", "second output"))
    release?.()

    const outcome = await finishing
    expect(outcome[0]!.data).toMatchObject({ requested: A, answered: A })

    // The delta belongs to the second turn, whose failure therefore must not be
    // retried. Crediting it to the finishing turn would have lost it in that
    // turn's drop.
    expect(await engine.onFailure(liveFailure())).toEqual({ suppress: false, events: [] })
    expect(calls).toHaveLength(0)
  })

  it("keeps a sticky ledgerError for non-full write failures and warns once", async () => {
    const warn = vi.fn()
    const { deps } = makeDeps({
      warn,
      recordImpl: async () => {
        throw new Error("disk is full")
      },
    })
    const engine = new FallbackEngine(deps)
    expect(engine.ledgerError()).toBe(false)

    engine.begin("s1", { text: "first" }, policy(), A)
    const first = await engine.onSuccess(successEvent("m1"))
    engine.begin("s2", { text: "second" }, policy(), A)
    const second = await engine.onSuccess(successEvent("m2", "s2"))

    // A failed write must not swallow the outcome or throw at the observer.
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(engine.ledgerError()).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("usage_ledger_write_failed")
  })
})
