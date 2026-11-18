import type { V2Event } from "@opencode/client"

const durable = { aggregateID: "ses_live", seq: 1, version: 1 }

/** Builds a V2 event with the fields the adapter reads. */
export function event(input: Record<string, unknown>): V2Event {
  return {
    id: `evt_${String(input.type)}`,
    created: 1_000,
    durable,
    ...input,
  } as unknown as V2Event
}

export function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${description}`))
        return
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}

export function gatedStream(events: V2Event[]): {
  stream: AsyncIterable<V2Event>
  release: () => void
  returned: () => number
} {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let returned = 0
  const stream: AsyncIterable<V2Event> = {
    [Symbol.asyncIterator](): AsyncIterator<V2Event> {
      let index = 0
      return {
        next: async () => {
          await gate
          if (index < events.length) {
            const value = events[index]
            index += 1
            if (value) return { value, done: false }
          }
          // Stay open until the adapter closes the subscription.
          await new Promise<void>(() => {})
          return { value: undefined, done: true }
        },
        return: async () => {
          returned += 1
          return { value: undefined, done: true }
        },
      }
    },
  }
  return { stream, release: () => release(), returned: () => returned }
}
