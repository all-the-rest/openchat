import { describe, expect, it, vi } from "vitest"
import type { OpenCodeClient } from "@opencode/client"
import { BackendError, FakeBackend } from "../src"
import { LiveBackend } from "../src/live"

function stubClient(options: { putFail?: boolean } = {}) {
  const put = vi.fn(async () => {
    if (options.putFail) throw new Error("upstream said no")
  })
  const client = {
    experimental: { session: { instructions: { entry: { put } } } },
  } as unknown as OpenCodeClient
  return { client, put }
}

function backendWith(client: OpenCodeClient): LiveBackend {
  return new LiveBackend({
    baseUrl: "http://unused",
    password: "unused",
    workspace: "/workspace",
    client,
  })
}

async function fakeWithSession(): Promise<{ backend: FakeBackend; sessionID: string }> {
  const backend = new FakeBackend({ delayMs: 0 })
  const info = await backend.createSession({ directory: "/workspace" })
  return { backend, sessionID: info.id }
}

describe("fake instructions", () => {
  it("stores and reads back one entry", async () => {
    const { backend, sessionID } = await fakeWithSession()

    expect(backend.getInstruction(sessionID, "memory.index")).toBeUndefined()
    await backend.putInstruction(sessionID, "memory.index", "remember this")
    expect(backend.getInstruction(sessionID, "memory.index")).toBe("remember this")
  })

  it("rejects an unknown session without storing anything", async () => {
    const backend = new FakeBackend({ delayMs: 0 })

    const failure = await backend
      .putInstruction("ses_missing", "memory.index", "value")
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).code).toBe("not_found")
    expect(backend.getInstruction.bind(backend, "ses_missing", "memory.index")).toThrow(
      BackendError,
    )
  })

  it("accepts the memory.index key", async () => {
    const { backend, sessionID } = await fakeWithSession()

    await backend.putInstruction(sessionID, "memory.index", "index body")
    expect(backend.getInstruction(sessionID, "memory.index")).toBe("index body")
  })

  it("replaces the value when the same key is written again", async () => {
    const { backend, sessionID } = await fakeWithSession()

    await backend.putInstruction(sessionID, "note", "first")
    await backend.putInstruction(sessionID, "note", "second")
    expect(backend.getInstruction(sessionID, "note")).toBe("second")
  })
})

describe("live instructions", () => {
  it("calls the instruction entry put surface with the exact arguments", async () => {
    const { client, put } = stubClient()

    await backendWith(client).putInstruction("ses_live", "memory.index", "live value")

    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith({
      sessionID: "ses_live",
      key: "memory.index",
      value: "live value",
    })
  })

  it("maps a rejected put to an unavailable BackendError", async () => {
    const { client } = stubClient({ putFail: true })

    const failure = await backendWith(client)
      .putInstruction("ses_live", "memory.index", "value")
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).code).toBe("unavailable")
    expect((failure as BackendError).message).not.toContain("upstream said no")
  })
})
