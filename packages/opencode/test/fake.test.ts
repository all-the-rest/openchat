import { describe, expect, it } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { EventEnvelope, Message } from "@openchat/contracts"
import { FakeBackend, resolveScenario } from "../src"

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function runUntilTerminal(
  backend: FakeBackend,
  sessionID: string,
  text: string,
): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = []
  const controller = new AbortController()
  const done = (async () => {
    for await (const event of backend.subscribe(controller.signal)) {
      events.push(event)
      if (
        event.type === EVENT.executionSucceeded ||
        event.type === EVENT.executionFailed ||
        event.type === EVENT.interrupted
      ) {
        controller.abort()
        break
      }
    }
  })()
  await backend.prompt(sessionID, { text })
  await withTimeout(done, 2000)
  return events
}

function assistantMessage(messages: Message[]): Message {
  const message = messages.find((entry) => entry.role === "assistant")
  if (!message) throw new Error("No assistant message")
  return message
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

describe("FakeBackend", () => {
  it("is deterministic with an injected clock", async () => {
    const backend = new FakeBackend({ delayMs: 0, now: () => 1000 })
    const session = await backend.createSession({ title: "Test", directory: "/workspace" })
    expect(session.id).toBe("ses_1")
    expect(session.created).toBe(1000)

    await backend.prompt(session.id, { text: "hello" })
    const messages = await backend.listMessages(session.id)
    expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
    expect(messages.every((message) => message.created === 1000)).toBe(true)
  })

  it("streams started, deltas, completion and success", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events = await runUntilTerminal(backend, session.id, "hello")

    expect(events[0]?.type).toBe(EVENT.executionStarted)
    expect(events.at(-2)?.type).toBe(EVENT.messageCompleted)
    expect(events.at(-1)?.type).toBe(EVENT.executionSucceeded)

    const deltas = events.filter((event) => event.type === EVENT.textDelta)
    expect(deltas.length).toBeGreaterThan(1)
    expect(typeof deltas[0]?.data.delta).toBe("string")
    expect(typeof deltas[0]?.data.partID).toBe("string")

    const messages = await backend.listMessages(session.id)
    expect(messages[0]?.role).toBe("user")
    expect(messages[0]?.parts[0]).toMatchObject({ type: "text", text: "hello" })
    const assistant = assistantMessage(messages)
    expect(assistant.status).toBe("complete")
    expect(textOf(assistant)).toBe(
      deltas.map((event) => String(event.data.delta)).join(""),
    )
  })

  it("reports deterministic usage for a completed run", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events = await runUntilTerminal(backend, session.id, "hello")

    const usageEvent = events.find((event) => event.type === EVENT.usageUpdated)
    expect(usageEvent?.data.usage).toEqual({ input: 1200, output: 340, cached: 512 })

    const listed = (await backend.listSessions()).find((entry) => entry.id === session.id)
    expect(listed?.usage).toEqual({ input: 1200, output: 340, cached: 512 })

    // A fresh chat has no report at all; absence is not a zero.
    const other = await backend.createSession({ directory: "/workspace" })
    const fresh = (await backend.listSessions()).find((entry) => entry.id === other.id)
    expect(fresh?.usage).toBeUndefined()
  })

  it("emits the rich scenario with reasoning, a tool and Markdown", async () => {    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events = await runUntilTerminal(backend, session.id, "rich: sample")

    expect(events.some((event) => event.type === EVENT.reasoningDelta)).toBe(true)
    const toolEvents = events.filter((event) => event.type === EVENT.toolUpdated)
    expect(toolEvents.map((event) => (event.data.part as { status: string }).status)).toEqual([
      "running",
      "success",
    ])

    const assistant = assistantMessage(await backend.listMessages(session.id))
    expect(assistant.parts.some((part) => part.type === "reasoning")).toBe(true)
    const body = textOf(assistant)
    for (const marker of [
      "## ",
      "**bold text**",
      "_italic text_",
      "`inline code`",
      "$e^{i\\pi}$",
      "| --- |",
      "> The fake backend",
      "```ts",
      "$$",
      "flowchart LR",
      "```mermaid",
    ]) {
      expect(body).toContain(marker)
    }
  })

  it("emits one successful and one failing tool in the tools scenario", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events = await runUntilTerminal(backend, session.id, "tools: run")

    const statuses = events
      .filter((event) => event.type === EVENT.toolUpdated)
      .map((event) => (event.data.part as { status: string }).status)
    expect(statuses).toEqual(["running", "success", "running", "error"])

    const assistant = assistantMessage(await backend.listMessages(session.id))
    const tools = assistant.parts.filter((part) => part.type === "tool")
    expect(tools.map((part) => (part.type === "tool" ? part.status : ""))).toEqual([
      "success",
      "error",
    ])
  })

  it("reports the error scenario without tools", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events = await runUntilTerminal(backend, session.id, "error: fail")

    const types = events.map((event) => event.type)
    expect(types).toContain(EVENT.error)
    expect(types).toContain(EVENT.executionFailed)
    expect(types.at(-1)).toBe(EVENT.executionFailed)

    const completed = events.find((event) => event.type === EVENT.messageCompleted)
    const completedMessage = completed?.data.message as Message
    expect(completedMessage.status).toBe("error")

    const assistant = assistantMessage(await backend.listMessages(session.id))
    expect(assistant.status).toBe("error")
    expect(assistant.parts.some((part) => part.type === "error")).toBe(true)
    expect(assistant.parts.some((part) => part.type === "tool")).toBe(false)
  })

  it("interrupts at the next tick and keeps the partial text", async () => {
    const backend = new FakeBackend({ delayMs: 10 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events: EventEnvelope[] = []
    let interrupted = false
    const controller = new AbortController()

    const consumed = (async () => {
      for await (const event of backend.subscribe(controller.signal)) {
        events.push(event)
        if (event.type === EVENT.textDelta && !interrupted) {
          interrupted = true
          await backend.interrupt(session.id)
        }
        if (event.type === EVENT.interrupted) {
          controller.abort()
          break
        }
      }
    })()

    await backend.prompt(session.id, { text: "slow: take your time" })
    await withTimeout(consumed, 2000)

    expect(interrupted).toBe(true)
    expect(events.map((event) => event.type)).toContain(EVENT.interrupted)
    const interruptionIndex = events.findIndex((event) => event.type === EVENT.interrupted)
    expect(
      events
        .slice(interruptionIndex + 1)
        .some((event) => event.type === EVENT.textDelta),
    ).toBe(false)

    const assistant = assistantMessage(await backend.listMessages(session.id))
    expect(assistant.status).toBe("stopped")
    expect(textOf(assistant).length).toBeGreaterThan(0)
  })

  it("fans out to every subscriber and cleans up on abort", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })

    const first = backend.subscribe()
    const second = backend.subscribe()
    const controller = new AbortController()
    const third = backend.subscribe(controller.signal)

    await backend.prompt(session.id, { text: "hello" })
    await new Promise((resolve) => setTimeout(resolve, 25))

    controller.abort()
    const thirdEvents: EventEnvelope[] = []
    for await (const event of third) thirdEvents.push(event)
    expect(thirdEvents).toHaveLength(0)

    const firstEvents: EventEnvelope[] = []
    for await (const event of first) {
      firstEvents.push(event)
      if (event.type === EVENT.executionSucceeded) break
    }
    expect(firstEvents.map((event) => event.id)).toContain("evt_3")

    let secondCount = 0
    for await (const event of second) {
      secondCount += 1
      expect(event.id).toBe(firstEvents[secondCount - 1]?.id)
      if (event.type === EVENT.executionSucceeded) break
    }
    expect(secondCount).toBe(firstEvents.length)
  })

  it("resolves scenario prefixes and falls back to the constructor scenario", () => {
    expect(resolveScenario("rich: hello", "default")).toBe("rich")
    expect(resolveScenario("reasoning: hello", "default")).toBe("reasoning")
    expect(resolveScenario("tools: hello", "default")).toBe("tools")
    expect(resolveScenario("error: hello", "default")).toBe("error")
    expect(resolveScenario("slow: hello", "default")).toBe("slow")
    expect(resolveScenario("hello", "tools")).toBe("tools")
  })

  it("rejects prompts for unknown sessions", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    await expect(backend.prompt("ses_missing", { text: "hello" })).rejects.toMatchObject({
      code: "not_found",
    })
  })
})
