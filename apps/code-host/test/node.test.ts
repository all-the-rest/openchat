import { EventEmitter } from "node:events"
import type { ServerResponse } from "node:http"
import { describe, expect, it, vi } from "vitest"
import { pumpResponseBody } from "../src/node"

/**
 * Minimal stand-in for a node response: `write` reports backpressure, and the
 * test emits `drain`/`close` itself. The real class needs a socket, which the
 * unit under test does not touch beyond these members.
 */
class FakeResponse extends EventEmitter {
  destroyed = false
  writableEnded = false
  ended = false
  blocking = true
  readonly written: Buffer[] = []

  write(chunk: Buffer): boolean {
    this.written.push(chunk)
    return !this.blocking
  }

  end(): void {
    this.ended = true
    this.writableEnded = true
  }
}

function asServerResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse
}

function withTimeout<T>(promise: Promise<T>, ms = 500): Promise<T> {
  const deadline = new Promise<T>((_resolve, reject) => {
    setTimeout(() => reject(new Error("pump did not settle")), ms)
  })
  return Promise.race([promise, deadline])
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("response pump", () => {
  it("settles and cancels the reader when a client disconnects during backpressure", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
      },
      cancel,
    })
    const response = new FakeResponse()
    const pump = pumpResponseBody(body, asServerResponse(response))

    await vi.waitFor(() => expect(response.written).toHaveLength(1))
    await tick()
    // The peer stops reading and goes away: node sets `destroyed` and emits
    // `close`, and `drain` never fires.
    response.destroyed = true
    response.emit("close")

    await expect(withTimeout(pump)).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.ended).toBe(false)
  })

  it("resumes after drain and ends cleanly", async () => {
    const cancel = vi.fn()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream
        stream.enqueue(new Uint8Array([1]))
      },
      cancel,
    })
    const response = new FakeResponse()
    const pump = pumpResponseBody(body, asServerResponse(response))

    await vi.waitFor(() => expect(response.written).toHaveLength(1))
    await tick()
    response.blocking = false
    response.emit("drain")
    controller?.close()

    await expect(withTimeout(pump)).resolves.toBeUndefined()
    expect(response.ended).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
  })

  it("cancels straight away when the response is already gone", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([9]))
      },
      cancel,
    })
    const response = new FakeResponse()
    response.destroyed = true

    await withTimeout(pumpResponseBody(body, asServerResponse(response)))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.written).toHaveLength(0)
    expect(response.ended).toBe(false)
  })
})
