import { describe, expect, it } from "vitest"
import { EventQueue, SUBSCRIBER_BUFFER_LIMIT } from "../src/events"

describe("EventQueue", () => {
  it("buffers at most its capacity and then ends the subscriber", async () => {
    const queue = new EventQueue<number>(4)
    for (let value = 0; value < 10; value += 1) queue.push(value)

    expect(queue.size).toBe(4)
    expect(queue.isClosed).toBe(true)

    const seen: number[] = []
    for await (const value of queue) seen.push(value)
    expect(seen).toEqual([0, 1, 2, 3])
    expect(queue.size).toBe(0)
  })

  it("delivers to a waiting consumer instead of buffering", async () => {
    const queue = new EventQueue<number>(1)
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    queue.push(1)
    expect(await pending).toEqual({ value: 1, done: false })

    // One value fits; the next one overflows and seals the queue, but the
    // buffered value is still drained before `done`.
    queue.push(2)
    queue.push(3)
    expect(queue.size).toBe(1)
    expect(await iterator.next()).toEqual({ value: 2, done: false })
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })

  it("defaults to SUBSCRIBER_BUFFER_LIMIT", () => {
    const queue = new EventQueue<number>()
    for (let value = 0; value < SUBSCRIBER_BUFFER_LIMIT + 10; value += 1) queue.push(value)
    expect(queue.size).toBe(SUBSCRIBER_BUFFER_LIMIT)
  })

  it("refuses a capacity below one", () => {
    expect(() => new EventQueue<number>(0)).toThrow()
    expect(() => new EventQueue<number>(1.5)).toThrow()
  })
})
