import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { EventEnvelope } from "@openchat/contracts"
import type { AppEnv } from "../src/app"
import { registerEventRoute } from "../src/events-route"
import type { EventSource } from "../src/events-route"
import type { RouteDeps } from "../src/routes"

async function until(predicate: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** An event source that counts how often the route pulls the next event. */
function scriptedSource(count: number) {
  const events: EventEnvelope[] = Array.from({ length: count }, (_, index) => ({
    id: `e${index}`,
    created: index,
    type: "test.event",
    data: { index },
  }))
  let pulled = 0
  const source: EventSource = {
    subscribe() {
      let index = 0
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              pulled += 1
              const event = events[index]
              index += 1
              return event === undefined
                ? { value: undefined, done: true }
                : { value: event, done: false }
            },
          }
        },
      }
    },
  }
  return { source, pulled: () => pulled }
}

function appWith(source: EventSource) {
  const app = new Hono<AppEnv>()
  registerEventRoute(app, {
    events: source,
    sseHeartbeatMs: 60_000,
  } as unknown as RouteDeps)
  return app
}

/**
 * Mirrors the observer's bounded subscriber queue: it buffers events, closes
 * once more than `limit` are unconsumed, and notifies the route on close.
 */
function boundedSource(limit: number) {
  let notifyClose: (() => void) | undefined
  let closed = false
  let closes = 0
  let pulls = 0
  let sequence = 0
  const values: EventEnvelope[] = []
  const waiters: Array<(result: IteratorResult<EventEnvelope>) => void> = []

  const close = () => {
    if (closed) return
    closed = true
    closes += 1
    values.length = 0
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    notifyClose?.()
  }

  const source: EventSource = {
    subscribe(_signal, onClose) {
      notifyClose = onClose
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            pulls += 1
            const value = values.shift()
            if (value !== undefined) return { value, done: false }
            if (closed) return { value: undefined, done: true }
            return new Promise<IteratorResult<EventEnvelope>>((resolve) => waiters.push(resolve))
          },
          return: async () => {
            close()
            return { value: undefined, done: true }
          },
        }),
      }
    },
  }

  const push = () => {
    if (closed) return
    const event: EventEnvelope = {
      id: `b${sequence}`,
      created: sequence,
      type: "test.event",
      data: { sequence },
    }
    sequence += 1
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ value: event, done: false })
      return
    }
    if (values.length >= limit) {
      close()
      return
    }
    values.push(event)
  }

  return { source, push, closes: () => closes, pulls: () => pulls }
}

describe("SSE backpressure", () => {
  it("writes only on a read and resumes the pump for the next event", async () => {
    const { source, pulled } = scriptedSource(3)
    const response = await appWith(source).request("/api/events")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    // The retry frame is written, then the pump pulls one event and parks
    // because the consumer has not read anything yet.
    await until(() => pulled() >= 1)
    expect(pulled()).toBe(1)

    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain("retry:")
    await until(() => pulled() >= 2)
    expect(pulled()).toBe(2)

    const second = await reader.read()
    expect(decoder.decode(second.value)).toContain('"index":0')

    await reader.cancel()
  })

  it("does not drain a never-read stream into the response", async () => {
    const { source, pulled } = scriptedSource(400)
    const response = await appWith(source).request("/api/events")

    // No reader is attached: the observer keeps the events, so its bounded
    // subscriber queue (not this response) decides when to reconnect.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pulled()).toBeLessThan(256)
    expect(pulled()).toBeLessThanOrEqual(1)

    await response.body?.cancel()
  })

  it("ends the response when the bounded queue closes a parked pump", async () => {
    const { source, push, closes, pulls } = boundedSource(4)
    const response = await appWith(source).request("/api/events")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    // The pump wrote the retry frame, pulled one event and then parked on
    // backpressure; the queue keeps filling, untouched by the response.
    await until(() => pulls() >= 1)
    for (let index = 0; index < 20 && closes() === 0; index += 1) push()
    expect(closes()).toBe(1)

    // The close notification ends the response instead of waiting for a read.
    expect(decoder.decode((await reader.read()).value)).toContain("retry:")
    expect((await reader.read()).done).toBe(true)

    // The subscription is gone: later events neither enqueue nor reopen it.
    push()
    expect(closes()).toBe(1)
    expect((await reader.read()).done).toBe(true)
  })
})
