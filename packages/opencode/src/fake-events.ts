import type { EventEnvelope } from "@openchat/contracts"
import { EventQueue } from "./events"

export type IdPrefix = "ses" | "msg" | "part" | "call" | "evt" | "cmp"

/**
 * Ids, the injected clock, durable sequence numbers and the subscriber
 * fan-out of the fake backend. Kept apart from the session store so message
 * scripting can emit events without knowing about sessions.
 */
export class FakeEvents {
  private readonly subscribers = new Set<EventQueue<EventEnvelope>>()
  private sessionCounter = 0
  private messageCounter = 0
  private partCounter = 0
  private callCounter = 0
  private eventCounter = 0
  private readonly durableCounters = new Map<string, number>()

  constructor(private readonly clock: () => number) {}

  nextID(prefix: IdPrefix): string {
    switch (prefix) {
      case "ses":
        this.sessionCounter += 1
        return `ses_${this.sessionCounter}`
      case "msg":
        this.messageCounter += 1
        return `msg_${this.messageCounter}`
      case "part":
        this.partCounter += 1
        return `part_${this.partCounter}`
      case "call":
        this.callCounter += 1
        return `call_${this.callCounter}`
      case "evt":
        this.eventCounter += 1
        return `evt_${this.eventCounter}`
      case "cmp":
        this.eventCounter += 1
        return `cmp_${this.eventCounter}`
    }
  }

  emit(
    type: string,
    sessionID: string,
    data: Record<string, unknown>,
    durable: boolean,
  ): EventEnvelope {
    const envelope: EventEnvelope = {
      id: this.nextID("evt"),
      created: this.clock(),
      type,
      data,
    }
    if (durable) {
      const seq = (this.durableCounters.get(sessionID) ?? 0) + 1
      this.durableCounters.set(sessionID, seq)
      envelope.durable = {
        aggregateID: sessionID,
        seq,
        version: 1,
      }
    }
    for (const subscriber of this.subscribers) subscriber.push(envelope)
    return envelope
  }

  subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    const queue = new EventQueue<EventEnvelope>()
    const cleanup = () => {
      this.subscribers.delete(queue)
      queue.close()
    }
    if (signal?.aborted) {
      queue.close()
      return queue
    }
    this.subscribers.add(queue)
    signal?.addEventListener("abort", cleanup, { once: true })

    const iterator = queue[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => iterator.next(),
        return: async () => {
          cleanup()
          signal?.removeEventListener("abort", cleanup)
          await iterator.return?.()
          return { value: undefined, done: true }
        },
      }),
    }
  }
}
