import { describe, expect, it } from "vitest"
import type { Message, SessionInfo } from "@openchat/contracts"
import { json, login, makeServer, openEvents } from "./helpers"

describe("sessions", () => {
  it("creates a session in WORKSPACE_DIR and lists it", async () => {
    const server = makeServer()
    const cookie = await login(server)

    const created = await server.app.request("/api/sessions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "First chat" }),
    })
    expect(created.status).toBe(200)
    const session = await json<SessionInfo>(created)
    expect(session.title).toBe("First chat")
    expect(session.directory).toBe("/workspace")
    expect(session.id).toBe("ses_1")

    const listed = await server.app.request("/api/sessions", { headers: { cookie } })
    expect(listed.status).toBe(200)
    expect(await json<SessionInfo[]>(listed)).toEqual([session])

    const messages = await server.app.request(`/api/sessions/${session.id}/messages`, {
      headers: { cookie },
    })
    expect(messages.status).toBe(200)
    expect(await json<Message[]>(messages)).toEqual([])
  })

  it("maps the parent link of a seeded subagent session", async () => {
    const server = makeServer({ seedSubagents: true })
    const cookie = await login(server)

    const listed = await json<SessionInfo[]>(
      await server.app.request("/api/sessions", { headers: { cookie } }),
    )
    const child = listed.find((session) => session.id === "ses_subagent_child")
    expect(child?.parentID).toBe("ses_subagent_parent")
    expect(listed.find((session) => session.id === "ses_subagent_parent")?.parentID).toBeUndefined()
  })

  it("requires authentication", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/sessions")
    expect(response.status).toBe(401)
  })

  it("returns JSON errors for invalid bodies", async () => {
    const server = makeServer()
    const cookie = await login(server)

    const empty = await server.app.request("/api/sessions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    })
    expect(empty.status).toBe(400)
    expect(await json(empty)).toMatchObject({
      error: { code: "invalid_request" },
    })

    const malformed = await server.app.request("/api/sessions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{",
    })
    expect(malformed.status).toBe(400)
  })

  it("returns 404 for unknown sessions", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/sessions/ses_missing/messages", {
      headers: { cookie },
    })
    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({
      error: { code: "not_found" },
    })
  })

  it("appends the user message immediately and reports the assistant id", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await json<SessionInfo>(
      await server.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    )

    const prompt = await server.app.request(`/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(prompt.status).toBe(200)
    const result = await json<{ ok: boolean; messageID: string }>(prompt)
    expect(result.ok).toBe(true)
    expect(result.messageID).toMatch(/^msg_/)

    const messages = await json<Message[]>(
      await server.app.request(`/api/sessions/${session.id}/messages`, {
        headers: { cookie },
      }),
    )
    expect(messages[0]).toMatchObject({
      role: "user",
      status: "complete",
      parts: [{ type: "text", text: "hello" }],
    })
    expect(messages[1]).toMatchObject({ id: result.messageID, role: "assistant" })
  })

  it("exposes server info", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/info", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      server: { mode: "fake", workspace: "/workspace" },
      scenario: "default",
    })
  })

  it("opens an authenticated event stream and rejects anonymous clients", async () => {
    const server = makeServer()
    const anonymous = await server.app.request("/api/events")
    expect(anonymous.status).toBe(401)

    const cookie = await login(server)
    const stream = await openEvents(server, cookie)
    expect(stream.events).toEqual([])
    await stream.close()
  })
})
