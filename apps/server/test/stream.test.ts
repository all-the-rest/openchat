import { describe, expect, it } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { EventEnvelope, Message, SessionInfo } from "@openchat/contracts"
import { json, login, makeServer, openEvents } from "./helpers"
import type { TestServer } from "./helpers"

async function createSession(server: TestServer, cookie: string, title = "Chat"): Promise<SessionInfo> {
  const response = await server.app.request("/api/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  return json<SessionInfo>(response)
}

async function prompt(server: TestServer, cookie: string, sessionID: string, text: string) {
  return server.app.request(`/api/sessions/${sessionID}/prompt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  })
}

function assistant(messages: Message[]): Message {
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

describe("remote-safe event stream", () => {
  it("sends unbuffered SSE with a keepalive comment", async () => {
    const server = makeServer({ sseHeartbeatMs: 20 })
    const cookie = await login(server)

    const response = await server.app.request("/api/events", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("cache-control")).toContain("no-cache")
    expect(response.headers.get("cache-control")).toContain("no-transform")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    // Consuming or cancelling the body runs the route's cleanup; leaving this
    // unread would keep its heartbeat interval alive for the rest of the worker.
    await response.body?.cancel()

    const stream = await openEvents(server, cookie)
    const deadline = Date.now() + 2_000
    while (!stream.rawText().includes(": heartbeat") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const raw = stream.rawText()
    expect(raw.startsWith("retry: 2000\n\n")).toBe(true)
    expect(raw).toContain(": heartbeat")
    await stream.close()
  })
})

describe("prompt and SSE", () => {
  it("streams started, deltas and completion to the browser", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const stream = await openEvents(server, cookie)

    const response = await prompt(server, cookie, session.id, "hello")
    expect(response.status).toBe(200)

    const completed = await stream.waitFor((event) => event.type === EVENT.messageCompleted)
    const types = stream.events.map((event) => event.type)

    expect(stream.rawText().startsWith("retry: 2000\n\n")).toBe(true)

    const startedIndex = types.indexOf(EVENT.executionStarted)
    const firstDeltaIndex = types.indexOf(EVENT.textDelta)
    const completedIndex = types.indexOf(EVENT.messageCompleted)
    expect(startedIndex).toBe(0)
    expect(firstDeltaIndex).toBeGreaterThan(startedIndex)
    expect(completedIndex).toBeGreaterThan(firstDeltaIndex)

    const snapshot = completed.data.message as Message
    expect(snapshot.status).toBe("complete")

    const deltas = stream.events.filter(
      (event: EventEnvelope) => event.type === EVENT.textDelta,
    )
    await stream.close()

    const messages = await json<Message[]>(
      await server.app.request(`/api/sessions/${session.id}/messages`, {
        headers: { cookie },
      }),
    )
    expect(messages[0]?.role).toBe("user")
    const reply = assistant(messages)
    expect(reply.status).toBe("complete")
    expect(textOf(reply)).toBe(deltas.map((event) => String(event.data.delta)).join(""))
    expect(textOf(reply).length).toBeGreaterThan(0)
  })

  it("interrupts the slow scenario after the first delta and keeps partial text", async () => {
    const server = makeServer({ scenario: "slow", delayMs: 25 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const stream = await openEvents(server, cookie)

    await prompt(server, cookie, session.id, "please take your time")
    await stream.waitForCount(EVENT.textDelta, 1)

    const interrupt = await server.app.request(`/api/sessions/${session.id}/interrupt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(interrupt.status).toBe(200)
    expect(await json(interrupt)).toEqual({ ok: true })

    await stream.waitFor((event) => event.type === EVENT.interrupted)
    const types = stream.events.map((event) => event.type)
    const interruptedIndex = types.indexOf(EVENT.interrupted)
    expect(interruptedIndex).toBeGreaterThan(types.indexOf(EVENT.textDelta))
    expect(
      types.slice(interruptedIndex + 1).includes(EVENT.textDelta),
    ).toBe(false)

    await stream.close()

    const messages = await json<Message[]>(
      await server.app.request(`/api/sessions/${session.id}/messages`, {
        headers: { cookie },
      }),
    )
    const reply = assistant(messages)
    expect(reply.status).toBe("stopped")
    expect(textOf(reply).length).toBeGreaterThan(0)
  })

  it("reports the error scenario end to end", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const stream = await openEvents(server, cookie)

    await prompt(server, cookie, session.id, "error: please fail")
    await stream.waitFor((event) => event.type === EVENT.executionFailed)

    const types = stream.events.map((event) => event.type)
    expect(types).toContain(EVENT.error)
    expect(types).toContain(EVENT.executionFailed)
    expect(types.at(-1)).toBe(EVENT.executionFailed)

    const completed = stream.events.find((event) => event.type === EVENT.messageCompleted)
    expect((completed?.data.message as Message).status).toBe("error")

    await stream.close()

    const messages = await json<Message[]>(
      await server.app.request(`/api/sessions/${session.id}/messages`, {
        headers: { cookie },
      }),
    )
    const reply = assistant(messages)
    expect(reply.status).toBe("error")
    expect(reply.parts.some((part) => part.type === "error")).toBe(true)
    expect(reply.parts.some((part) => part.type === "tool")).toBe(false)
  })
})
