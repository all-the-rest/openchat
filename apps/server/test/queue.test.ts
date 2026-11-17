import { describe, expect, it } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { Message, PromptResponse, SessionInfo } from "@openchat/contracts"
import { json, login, makeServer, openEvents } from "./helpers"
import type { TestServer } from "./helpers"

async function createSession(server: TestServer, cookie: string): Promise<SessionInfo> {
  const response = await server.app.request("/api/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  })
  return json<SessionInfo>(response)
}

async function prompt(
  server: TestServer,
  cookie: string,
  sessionID: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return server.app.request(`/api/sessions/${sessionID}/prompt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

describe("queued prompts", () => {
  it("accepts a second prompt with delivery=queue and runs it after the active turn", async () => {
    const server = makeServer({ scenario: "slow", delayMs: 25 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const stream = await openEvents(server, cookie)

    const first = await prompt(server, cookie, session.id, { text: "first" })
    expect(first.status).toBe(200)
    await stream.waitFor((event) => event.type === EVENT.textDelta)

    const queued = await prompt(server, cookie, session.id, {
      text: "second",
      delivery: "queue",
    })
    expect(queued.status).toBe(200)
    const queuedBody = await json<PromptResponse>(queued)
    expect(queuedBody.ok).toBe(true)
    expect(queuedBody.queued).toBe(true)
    expect(typeof queuedBody.messageID).toBe("string")

    await stream.waitForCount(EVENT.executionSucceeded, 2)
    await stream.close()

    const messages = await json<Message[]>(
      await server.app.request(`/api/sessions/${session.id}/messages`, { headers: { cookie } }),
    )
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    expect(messages[0]?.role === "user" ? textOf(messages[0]) : "").toBe("first")
    expect(messages[2]?.role === "user" ? textOf(messages[2]) : "").toBe("second")
    expect(messages[1]?.status).toBe("complete")
    expect(messages[3]?.status).toBe("complete")
  })

  it("queues a prompt without an explicit delivery mode while a run is active", async () => {
    const server = makeServer({ scenario: "slow", delayMs: 25 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const stream = await openEvents(server, cookie)

    await prompt(server, cookie, session.id, { text: "first" })
    await stream.waitFor((event) => event.type === EVENT.textDelta)

    const queued = await prompt(server, cookie, session.id, { text: "second" })
    expect(queued.status).toBe(200)
    expect(await json<PromptResponse>(queued)).toMatchObject({ ok: true, queued: true })

    await stream.waitForCount(EVENT.executionSucceeded, 2)
    await stream.close()
  })

  it("does not report queued when the session is idle", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)

    const response = await prompt(server, cookie, session.id, {
      text: "hello",
      delivery: "queue",
    })
    expect(response.status).toBe(200)
    const body = await json<PromptResponse>(response)
    expect(body.ok).toBe(true)
    expect(body.queued).toBeUndefined()
  })
})
