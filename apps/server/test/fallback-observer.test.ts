import type { EventEnvelope } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import { FakeBackend } from "@openchat/opencode"
import { describe, expect, it, vi } from "vitest"

import type { FallbackEngine } from "../src/fallback-engine"
import { FallbackObserver, UPSTREAM_SETTLE_MS } from "../src/fallback-observer"

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

  it("warns once across several failed reconnect attempts", async () => {
    let calls = 0
    const subscribe = vi.fn(() => {
      calls += 1
      return {
        [Symbol.asyncIterator]: async function* () {
          throw new Error("host down")
        },
      }
    })
    const warn = vi.fn()
    const observer = new FallbackObserver({
      backend: { subscribe },
      engine: stubEngine(),
      warn,
      reconnectMs: 1,
    })

    observer.start()
    await until(() => calls >= 4, 5000)

    // One outage, one line: the 1 s reconnect loop must not repeat it.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fallback event stream failed"))
    observer.stop()
  })

  it("warns again when a stream that recovered drops later", async () => {
    const ends: Array<() => void> = []
    const subscribe = vi.fn(() => {
      let end!: () => void
      const gate = new Promise<void>((resolve) => {
        end = resolve
      })
      ends.push(end)
      return {
        [Symbol.asyncIterator]: async function* () {
          await gate
        },
      }
    })
    const warn = vi.fn()
    const observer = new FallbackObserver({
      backend: { subscribe },
      engine: stubEngine(),
      warn,
      reconnectMs: 1,
    })

    const settle = () => new Promise((resolve) => setTimeout(resolve, UPSTREAM_SETTLE_MS + 25))
    observer.start()

    await until(() => ends.length >= 1)
    await settle()
    ends[0]?.()
    await until(() => warn.mock.calls.length >= 1)

    // The replacement has to survive the settle window too; only then is its
    // drop a new outage rather than the tail of the first one.
    await until(() => ends.length >= 2)
    await settle()
    ends[1]?.()
    await until(() => warn.mock.calls.length >= 2)

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fallback event stream ended"))
    observer.stop()
  })

  it("stop aborts the host subscription and clears the reconnect timer", async () => {
    let signal: AbortSignal | undefined
    let ended = false
    const subscribe = vi.fn((incoming: AbortSignal) => {
      signal = incoming
      return {
        [Symbol.asyncIterator]: () => {
          let done = false
          return {
            next: () =>
              new Promise<IteratorResult<EventEnvelope>>((resolve) => {
                incoming.addEventListener(
                  "abort",
                  () => {
                    if (done) return
                    done = true
                    ended = true
                    resolve({ value: undefined, done: true })
                  },
                  { once: true },
                )
              }),
          }
        },
      }
    })
    const observer = new FallbackObserver({
      backend: { subscribe },
      engine: stubEngine(),
      reconnectMs: 5,
    })

    observer.start()
    await until(() => signal !== undefined)
    observer.stop()

    expect(signal?.aborted).toBe(true)
    await until(() => ended)
    // A stopped observer must not reconnect even after its delay passes.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it("closes a browser stream when the host stream drops", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const subscribe = vi.fn(() => ({
      [Symbol.asyncIterator]: async function* () {
        await gate
      },
    }))
    const observer = new FallbackObserver({
      backend: { subscribe },
      engine: stubEngine(),
      warn: vi.fn(),
      reconnectMs: 60_000,
    })

    observer.start()
    let ended = false
    void (async () => {
      for await (const _event of observer.subscribe()) {
        // No event is expected; the loop only has to end.
      }
      ended = true
    })()

    release()
    await until(() => ended)
    expect(ended).toBe(true)
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
