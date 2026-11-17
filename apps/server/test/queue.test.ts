import { describe, expect, it } from "vitest"
import { EVENT } from "@openchat/contracts"
import type {
  InboxResponse,
  Message,
  PromptResponse,
  SessionInfo,
} from "@openchat/contracts"
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

async function inbox(server: TestServer, cookie: string, sessionID: string): Promise<InboxResponse> {
  return json<InboxResponse>(
    await server.app.request(`/api/sessions/${sessionID}/inbox`, { headers: { cookie } }),
  )
}

async function cancel(
  server: TestServer,
  cookie: string,
  sessionID: string,
  messageID: string,
  jsonContentType = true,
): Promise<Response> {
  return server.app.request(`/api/sessions/${sessionID}/inbox/${messageID}`, {
    method: "DELETE",
    headers: jsonContentType ? { cookie, "content-type": "application/json" } : { cookie },
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

describe("session inbox", () => {
  it("lists a queued turn and cancels it by the prompt response id", async () => {
    const server = makeServer({ scenario: "slow", delayMs: 25 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const stream = await openEvents(server, cookie)

    await prompt(server, cookie, session.id, { text: "first" })
    await stream.waitFor((event) => event.type === EVENT.textDelta)

    const queued = await prompt(server, cookie, session.id, {
      text: "second",
      delivery: "queue",
    })
    expect(queued.status).toBe(200)
    const { messageID } = await json<PromptResponse>(queued)

    const listed = await inbox(server, cookie, session.id)
    expect(listed.entries).toEqual([
      {
        id: messageID,
        sessionID: session.id,
        kind: "user",
        text: "second",
        delivery: "queue",
        created: expect.any(Number),
      },
    ])

    const cancelled = await cancel(server, cookie, session.id, messageID)
    expect(cancelled.status).toBe(200)
    expect(await json(cancelled)).toEqual({ ok: true })
    expect((await inbox(server, cookie, session.id)).entries).toEqual([])

    const messages = await json<Message[]>(
      await server.app.request(`/api/sessions/${session.id}/messages`, { headers: { cookie } }),
    )
    expect(messages.some((message) => message.id === messageID)).toBe(false)

    await stream.close()
  })

  it("answers 404 for an unknown session and an unknown queue entry", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)

    const missingSession = await server.app.request("/api/sessions/ses_missing/inbox", {
      headers: { cookie },
    })
    expect(missingSession.status).toBe(404)
    expect(await json(missingSession)).toMatchObject({ error: { code: "not_found" } })

    const missingEntry = await cancel(server, cookie, session.id, "msg_missing")
    expect(missingEntry.status).toBe(404)
    expect(await json(missingEntry)).toMatchObject({ error: { code: "not_found" } })
  })

  it("keeps the JSON content-type rule on the DELETE", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const response = await cancel(server, cookie, session.id, "msg_missing", false)
    expect(response.status).toBe(415)
  })
})

describe("prompt throttle", () => {
  it("answers the 31st prompt with 429 and Retry-After", async () => {
    const server = makeServer({ delayMs: 0 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await prompt(server, cookie, session.id, {
        text: `prompt ${attempt}`,
        delivery: "queue",
      })
      expect(response.status).toBe(200)
    }

    const blocked = await prompt(server, cookie, session.id, {
      text: "one too many",
      delivery: "queue",
    })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await json(blocked)).toMatchObject({ error: { code: "too_many_requests" } })
  })

  it("lets a normal burst through and does not throttle interrupt", async () => {
    const server = makeServer({ delayMs: 0 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await prompt(server, cookie, session.id, {
        text: `hello ${attempt}`,
        delivery: "queue",
      })
      expect(response.status).toBe(200)
    }

    // Interrupt stays outside the prompt budget.
    for (let attempt = 1; attempt <= 35; attempt += 1) {
      const response = await server.app.request(`/api/sessions/${session.id}/interrupt`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status).toBe(200)
    }
  })
})
