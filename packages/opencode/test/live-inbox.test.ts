import { describe, expect, it } from "vitest"
import type { EventEnvelope } from "@openchat/contracts"
import type { OpenCodeClient, V2Event } from "@opencode/client"
import { SUBSCRIBER_BUFFER_LIMIT } from "../src/events"
import { LiveBackend } from "../src/live"
import { event, gatedStream, waitFor } from "./live-helpers"

function liveBackend(stream: AsyncIterable<V2Event>): LiveBackend {
  const client = {
    event: { subscribe: () => stream },
  } as unknown as OpenCodeClient
  return new LiveBackend({
    baseUrl: "http://unused",
    password: "unused",
    workspace: "/workspace",
    client,
  })
}

describe("live inbox events", () => {
  it("delivers all four session.inbox.* events to a subscriber", async () => {
    const events = [
      event({
        id: "evt_enqueued",
        type: "session.inbox.enqueued",
        data: {
          sessionID: "ses_live",
          inboxID: "msg_queued",
          item: { type: "user", payload: { text: "second question" }, delivery: "queue" },
        },
      }),
      event({
        id: "evt_delivered",
        type: "session.inbox.delivered",
        data: { sessionID: "ses_live", inboxID: "msg_queued" },
      }),
      event({
        id: "evt_cancelled",
        type: "session.inbox.cancelled",
        data: { sessionID: "ses_live", inboxID: "msg_cancelled" },
      }),
      event({
        id: "evt_delivery",
        type: "session.inbox.delivery.changed",
        data: { sessionID: "ses_live", inboxID: "msg_queued", delivery: "steer" },
      }),
    ]
    const { stream, release } = gatedStream(events)
    const backend = liveBackend(stream)
    const controller = new AbortController()
    const seen: EventEnvelope[] = []
    const run = (async () => {
      for await (const entry of backend.subscribe(controller.signal)) seen.push(entry)
    })()

    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await waitFor(() => seen.length === 4, "inbox events")

    expect(seen.map((entry) => entry.type)).toEqual([
      "session.inbox.enqueued",
      "session.inbox.delivered",
      "session.inbox.cancelled",
      "session.inbox.delivery.changed",
    ])
    // `inboxID` is flattened to `messageID`, and the enqueued item keeps the
    // fields the browser needs to render and cancel the queued turn.
    expect(seen[0]?.data).toEqual({
      sessionID: "ses_live",
      messageID: "msg_queued",
      kind: "user",
      text: "second question",
      delivery: "queue",
      created: 1_000,
    })
    expect(seen[1]?.data).toEqual({ sessionID: "ses_live", messageID: "msg_queued" })
    expect(seen[2]?.data).toEqual({ sessionID: "ses_live", messageID: "msg_cancelled" })
    expect(seen[3]?.data).toEqual({
      sessionID: "ses_live",
      messageID: "msg_queued",
      delivery: "steer",
    })

    controller.abort()
    await run
  })

  it("stops a subscriber that never drains at the buffer bound", async () => {
    const total = SUBSCRIBER_BUFFER_LIMIT + 5
    const events = Array.from({ length: total }, (_, index) =>
      event({
        id: `evt_${index}`,
        type: "session.text.delta",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          ordinal: 0,
          delta: String(index),
        },
      }),
    )
    // The upstream stays open after the burst, so only the queue's bound can
    // end the subscriber.
    const { stream, release } = gatedStream(events)
    const backend = liveBackend(stream)

    const controller = new AbortController()
    const iterator = backend.subscribe(controller.signal)[Symbol.asyncIterator]()
    const firstPromise = iterator.next()
    release()
    const first = await firstPromise
    expect(first.done).toBe(false)

    // The consumer stays idle while the pump fills the queue; only microtasks
    // run, so the outcome does not depend on a timer or the wall clock.
    for (let tick = 0; tick < total * 4; tick += 1) await Promise.resolve()

    const received: EventEnvelope[] = first.done ? [] : [first.value]
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      received.push(next.value)
    }

    // One event was delivered directly, the bound was buffered and the rest
    // were refused; the stream then ended instead of growing.
    expect(received).toHaveLength(SUBSCRIBER_BUFFER_LIMIT + 1)
    expect(received.at(-1)?.data.delta).toBe(String(SUBSCRIBER_BUFFER_LIMIT))

    controller.abort()
  })
})
