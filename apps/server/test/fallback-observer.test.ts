import type { EventEnvelope } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import { FakeBackend } from "@openchat/opencode"
import { describe, expect, it, vi } from "vitest"

import type { FallbackEngine } from "../src/fallback-engine"
import { FallbackObserver } from "../src/fallback-observer"

function stubEngine() {
  return {
    observe: vi.fn(),
    onFailure: vi.fn(async () => ({ suppress: false, events: [] })),
    onSuccess: vi.fn(async () => []),
    forget: vi.fn(),
  } as unknown as Pick<FallbackEngine, "observe" | "onFailure" | "onSuccess" | "forget">
}

function emptyStream(): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]: async function* () {
      // Never yields; the observer is stopped by the test.
    },
  }
}

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("FallbackObserver", () => {
  it("opens exactly one host subscription even when start is called twice", () => {
    const subscribe = vi.fn(() => emptyStream())
    const observer = new FallbackObserver({
      backend: { subscribe },
      engine: stubEngine(),
    })

    observer.start()
    observer.start()

    expect(subscribe).toHaveBeenCalledTimes(1)
    observer.stop()
  })

  it("logs a dropped stream and reconnects", async () => {
    let calls = 0
    const subscribe = vi.fn(() => {
      calls += 1
      return emptyStream()
    })
    const warn = vi.fn()
    const observer = new FallbackObserver({
      backend: { subscribe },
      engine: stubEngine(),
      warn,
      reconnectMs: 1,
    })

    observer.start()
    await until(() => calls >= 2)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fallback event stream ended"))
    observer.stop()
  })

  it("keeps other sessions flowing while a retry is still being submitted", async () => {
    const backend = new FakeBackend({ delayMs: 0, workspace: "/workspace" })
    const blocked = new Promise<never>(() => {})
    const engine = {
      observe: vi.fn(),
      onFailure: vi.fn(() => blocked),
      onSuccess: vi.fn(async () => []),
      forget: vi.fn(),
    } as unknown as Pick<FallbackEngine, "observe" | "onFailure" | "onSuccess" | "forget">
    const observer = new FallbackObserver({ backend, engine })
    observer.start()

    const seen: EventEnvelope[] = []
    const abort = new AbortController()
    const consumed = (async () => {
      for await (const event of observer.subscribe(abort.signal)) seen.push(event)
    })()

    const first = await backend.createSession({ directory: "/workspace" })
    const second = await backend.createSession({ directory: "/workspace" })
    await backend.prompt(first.id, { text: "fallback: blocked" })
    await backend.prompt(second.id, { text: "hello" })

    await until(() =>
      seen.some(
        (event) =>
          event.type === EVENT.executionSucceeded && event.data.sessionID === second.id,
      ),
    )
    // The first session's failure is held for its pending decision; the second
    // session's events were never blocked behind it.
    expect(
      seen.some(
        (event) => event.type === EVENT.executionFailed && event.data.sessionID === first.id,
      ),
    ).toBe(false)

    abort.abort()
    observer.stop()
    await consumed.catch(() => {})
  })
})
