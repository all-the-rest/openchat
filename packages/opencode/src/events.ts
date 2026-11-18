/**
 * Events one subscriber may have buffered before the fan-out closes it. The
 * browser reconnects the SSE stream and re-reads the transcript snapshot, so a
 * consumer that cannot keep up recovers with a consistent state; growing its
 * buffer instead would let one stalled tab exhaust the server's memory.
 *
 * 256 events is a few seconds of a token stream at typical delta rates — far
 * below the point where a busy stream needs unbounded room, and far above the
 * burst one render tick leaves behind.
 */
export const SUBSCRIBER_BUFFER_LIMIT = 256

/**
 * Single-consumer async queue with a bounded buffer. The fake backend and the
 * live adapter use it as the fan-out hop between the backend stream and one
 * subscriber, so a slow consumer never blocks the others.
 *
 * On overflow the queue closes instead of dropping the newest value: dropping
 * a delta would silently corrupt the transcript, while a closed stream is a
 * signal the transport already handles as a reconnect.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false
  private readonly capacity: number

  constructor(capacity: number = SUBSCRIBER_BUFFER_LIMIT) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("EventQueue needs room for at least one event")
    }
    this.capacity = capacity
  }

  /** Buffered events; exposed for tests. */
  get size(): number {
    return this.values.length
  }

  get isClosed(): boolean {
    return this.closed
  }

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    if (this.values.length >= this.capacity) {
      // Stop accepting work immediately but let the consumer drain what fits
      // before its iterator reports `done`.
      this.seal()
      return
    }
    this.values.push(value)
  }

  close(): void {
    this.seal()
    this.values.length = 0
  }

  private seal(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}
