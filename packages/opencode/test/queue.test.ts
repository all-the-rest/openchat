import { describe, expect, it } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { EventEnvelope, Message } from "@openchat/contracts"
import { FakeBackend } from "../src"

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

describe("FakeBackend queueing", () => {
  it("queues a prompt during a run and executes it in order", async () => {
    const backend = new FakeBackend({ delayMs: 10 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events: EventEnvelope[] = []
    const controller = new AbortController()
    const consumed = (async () => {
      for await (const event of backend.subscribe(controller.signal)) events.push(event)
    })()

    const first = await backend.prompt(session.id, { text: "first" })
    expect(first.queued).toBeUndefined()
    await waitFor(
      () => events.some((event) => event.type === EVENT.executionStarted),
      "the active run",
    )

    const second = await backend.prompt(session.id, { text: "second", delivery: "queue" })
    expect(second.queued).toBe(true)
    const third = await backend.prompt(session.id, { text: "third", delivery: "queue" })
    expect(third.queued).toBe(true)

    await waitFor(
      () => events.filter((event) => event.type === EVENT.executionSucceeded).length === 3,
      "all three runs",
    )
    controller.abort()
    await consumed.catch(() => {})

    const startedRuns = events.filter((event) => event.type === EVENT.executionStarted)
    expect(startedRuns).toHaveLength(3)

    // The active turn is not restarted, edited or kept open by the queued
    // prompts: all of its deltas land before the first execution succeeds.
    const firstSucceeded = events.findIndex(
      (event) => event.type === EVENT.executionSucceeded,
    )
    expect(firstSucceeded).toBeGreaterThan(-1)
    const firstDeltas = events.filter(
      (event) => event.type === EVENT.textDelta && event.data.messageID === first.messageID,
    )
    expect(firstDeltas.length).toBeGreaterThan(0)
    expect(
      firstDeltas.every((event) => events.indexOf(event) < firstSucceeded),
    ).toBe(true)

    const messages = await backend.listMessages(session.id)
    // Queued user messages are appended immediately (shown as pending); their
    // assistant messages appear when each queued turn starts.
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
      "assistant",
      "assistant",
    ])
    expect(
      messages
        .filter((message) => message.role === "user")
        .map((message) => textOf(message)),
    ).toEqual(["first", "second", "third"])
    expect(messages[2]?.id).toBe(second.messageID)
    expect(messages[3]?.id).toBe(third.messageID)
    expect(messages.map((message) => message.status)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
    ])

    const replied = messages.filter((message) => message.role === "assistant")
    for (const message of replied) expect(textOf(message).length).toBeGreaterThan(0)
  })

  it("still rejects a simultaneous prompt that did not ask for queueing", async () => {
    const backend = new FakeBackend({ delayMs: 50 })
    const session = await backend.createSession({ directory: "/workspace" })
    await backend.prompt(session.id, { text: "first" })

    await expect(backend.prompt(session.id, { text: "second" })).rejects.toMatchObject({
      code: "conflict",
    })
    await backend.interrupt(session.id)
  })

  it("starts a queue-intent prompt immediately when the session is idle", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const result = await backend.prompt(session.id, { text: "hello", delivery: "queue" })
    expect(result.queued).toBeFalsy()
    // `delayMs: 0` still settles on the microtask queue, so poll instead of
    // sleeping a fixed slice: a loaded CI worker must not turn this red.
    let messages = await backend.listMessages(session.id)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (messages.every((message) => message.status === "complete")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
      messages = await backend.listMessages(session.id)
    }
    expect(messages.map((message) => message.status)).toEqual(["complete", "complete"])
  })
})

describe("FakeBackend inbox", () => {
  it("lists pending turns and cancels one by its message id", async () => {
    const backend = new FakeBackend({ delayMs: 50 })
    const session = await backend.createSession({ directory: "/workspace" })
    await backend.prompt(session.id, { text: "first" })

    const second = await backend.prompt(session.id, { text: "second", delivery: "queue" })
    const third = await backend.prompt(session.id, { text: "third", delivery: "queue" })
    expect(second.queued).toBe(true)
    expect(third.queued).toBe(true)

    const entries = await backend.listInbox(session.id)
    expect(entries.map((entry) => entry.id)).toEqual([second.messageID, third.messageID])
    expect(entries.map((entry) => entry.text)).toEqual(["second", "third"])
    expect(entries.every((entry) => entry.kind === "user" && entry.delivery === "queue")).toBe(true)

    await backend.cancelQueued(session.id, second.messageID)
    expect((await backend.listInbox(session.id)).map((entry) => entry.id)).toEqual([
      third.messageID,
    ])
    const messages = await backend.listMessages(session.id)
    expect(messages.some((message) => message.id === second.messageID)).toBe(false)

    await backend.cancelQueued(session.id, third.messageID)
    expect(await backend.listInbox(session.id)).toEqual([])
    await backend.interrupt(session.id)
  })

  it("rejects an unknown session and an unknown queue entry", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    await expect(backend.listInbox("ses_missing")).rejects.toMatchObject({
      code: "not_found",
    })
    const session = await backend.createSession({ directory: "/workspace" })
    await expect(backend.cancelQueued(session.id, "msg_missing")).rejects.toMatchObject({
      code: "not_found",
    })
  })
})
