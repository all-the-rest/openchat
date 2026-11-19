import type { ModelRef, TurnPolicy } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import type { PromptInput } from "@openchat/opencode"
import { describe, expect, it } from "vitest"

import type { EngineEvent, FallbackEngineDeps } from "../src/fallback-engine"
import { FallbackEngine } from "../src/fallback-engine"

const A: ModelRef = { providerID: "acme", modelID: "a" }
const B: ModelRef = { providerID: "acme", modelID: "b" }

function policy(): TurnPolicy {
  return { surface: "chat", chain: [A, B], paidDailyTurns: 10, contextSoftCap: 0 }
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

/** Live host shape: the prompt response is the user inbox id, terminal events
 * carry only `sessionID`, deltas carry the assistant message id. */
function liveFailure(sessionID = "s1"): EngineEvent {
  return {
    type: EVENT.executionFailed,
    data: { sessionID, message: "Rate limit reached", code: "rate_limit" },
  }
}

function failureEvent(messageID: string, sessionID = "s1"): EngineEvent {
  return {
    type: EVENT.executionFailed,
    data: { sessionID, messageID, message: "Rate limit reached", code: "rate_limit" },
  }
}

function delta(messageID: string, text = "x", sessionID = "s1"): EngineEvent {
  return {
    type: EVENT.textDelta,
    data: { sessionID, messageID, partID: "p1", delta: text },
  }
}

describe("assistant output ownership", () => {
  it("credits a delta by assistant id after adopting the user inbox id", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    const token = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", token, "user_a")

    // The response id is the user's entry, the delta carries the assistant id.
    engine.observe(delta("asst_a"))

    // Output was seen, so the failure must be forwarded, not retried: a retry
    // would re-run visible work and bill an extra turn.
    expect(await engine.onFailure(liveFailure())).toEqual({ suppress: false, events: [] })
    expect(calls).toHaveLength(0)
    expect(engine.activeCount()).toBe(0)
  })

  it("credits a second turn's output to its own assistant id", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "user_a")
    engine.observe(delta("asst_a"))

    // A's failure is forwarded and closes A; B starts its own turn afterwards.
    expect((await engine.onFailure(liveFailure())).suppress).toBe(false)

    const second = engine.begin("s1", { text: "second" }, policy(), A)
    engine.adopt("s1", second, "user_b")
    engine.observe(delta("asst_b"))

    expect((await engine.onFailure(liveFailure())).suppress).toBe(false)
    expect(calls).toHaveLength(0)
    expect(engine.activeCount()).toBe(0)
  })

  it("credits a late asst_a delta to A without blocking B", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "user_a")
    const second = engine.begin("s1", { text: "second" }, policy(), A)
    engine.adopt("s1", second, "user_b")

    // A is the oldest awaiting turn, so its assistant id is credited there.
    engine.observe(delta("asst_a", "late output"))
    engine.observe(delta("asst_a", " more"))

    // A's failure is forwarded (it had shown output and is superseded) …
    expect((await engine.onFailure(liveFailure())).suppress).toBe(false)
    expect(calls).toHaveLength(0)

    // … and B, which emitted nothing, is still retryable with its own text.
    expect((await engine.onFailure(liveFailure())).suppress).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input.text).toBe("second")
  })

  it("ignores a delta for a retired retry id", async () => {
    const { deps, calls } = makeDeps()
    const engine = new FallbackEngine(deps)
    const first = engine.begin("s1", { text: "first" }, policy(), A)
    engine.adopt("s1", first, "user_a")

    // The retry replaces the id and retires it.
    expect((await engine.onFailure(failureEvent("user_a"))).suppress).toBe(true)
    expect(calls).toHaveLength(1)

    const second = engine.begin("s1", { text: "second" }, policy(), A)
    engine.adopt("s1", second, "user_b")
    engine.observe(delta("user_a"))

    // The retired id did not credit B, so B's first failure still retries.
    const result = await engine.onFailure(failureEvent("user_b"))
    expect(result.suppress).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.input.text).toBe("second")
  })
})
