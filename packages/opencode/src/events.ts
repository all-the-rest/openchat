/**
 * Single-consumer async queue with a bounded-by-use buffer. The fake backend and
 * the live adapter use it as the fan-out hop between the backend stream and one
 * subscriber, so a slow consumer never blocks the others.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.values.length = 0
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
