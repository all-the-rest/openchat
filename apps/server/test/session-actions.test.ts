import { describe, expect, it } from "vitest"
import type { FormRequest, SessionInfo } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"

async function createChat(server: ReturnType<typeof makeServer>, cookie: string, title = "Chat") {
  const response = await server.app.request("/api/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  return json<SessionInfo>(response)
}

describe("PATCH /api/sessions/:id", () => {
  it("renames a chat and answers the refreshed row", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie, "Old title")

    const response = await server.app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    })
    expect(response.status).toBe(200)
    expect(await json<SessionInfo>(response)).toMatchObject({
      id: session.id,
      title: "New title",
    })

    const listed = await json<SessionInfo[]>(
      await server.app.request("/api/sessions", { headers: { cookie } }),
    )
    expect(listed[0]?.title).toBe("New title")
  })

  it("rejects an invalid title and an unknown chat", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)

    for (const body of [JSON.stringify({ title: "" }), JSON.stringify({}), "{}"]) {
      const response = await server.app.request(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body,
      })
      expect(response.status).toBe(400)
      expect(await json(response)).toMatchObject({ error: { code: "invalid_request" } })
    }

    const missing = await server.app.request("/api/sessions/ses_missing", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Title" }),
    })
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({ error: { code: "not_found" } })
  })

  it("requires a JSON content type and authentication", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)

    const noType = await server.app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ title: "New title" }),
    })
    expect(noType.status).toBe(415)

    const anonymous = await server.app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    })
    expect(anonymous.status).toBe(401)
  })
})

describe("DELETE /api/sessions/:id", () => {
  it("removes the chat from the list", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const first = await createChat(server, cookie, "First")
    await createChat(server, cookie, "Second")

    const response = await server.app.request(`/api/sessions/${first.id}`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(200)

    const listed = await json<SessionInfo[]>(
      await server.app.request("/api/sessions", { headers: { cookie } }),
    )
    expect(listed.map((session) => session.title)).toEqual(["Second"])
  })

  it("answers 404 for an unknown chat", async () => {
    const server = makeServer()
    const cookie = await login(server)

    const response = await server.app.request("/api/sessions/ses_missing", {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({ error: { code: "not_found" } })
  })
})

describe("form routes", () => {
  it("lists the open form and removes it after the reply", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    const form = server.backend.seedForm(session.id)

    const listed = await server.app.request(`/api/sessions/${session.id}/forms`, {
      headers: { cookie },
    })
    expect(listed.status).toBe(200)
    const body = await json<{ forms: FormRequest[] }>(listed)
    expect(body.forms.map((entry) => entry.id)).toEqual([form.id])
    expect(body.forms[0]?.fields.map((field) => field.type)).toEqual([
      "string",
      "string",
      "boolean",
    ])

    const reply = await server.app.request(`/api/sessions/${session.id}/forms/${form.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        answer: { summary: "Costs", tone: "brief", confirm: true },
      }),
    })
    expect(reply.status).toBe(200)
    expect(await json(reply)).toEqual({ ok: true })

    const again = await json<{ forms: FormRequest[] }>(
      await server.app.request(`/api/sessions/${session.id}/forms`, { headers: { cookie } }),
    )
    expect(again.forms).toEqual([])
  })

  it("rejects an invalid answer, an unknown form and an unknown chat", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    const form = server.backend.seedForm(session.id)

    const invalid = await server.app.request(`/api/sessions/${session.id}/forms/${form.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "not-a-record" }),
    })
    expect(invalid.status).toBe(400)
    expect(await json(invalid)).toMatchObject({ error: { code: "invalid_request" } })

    const unknown = await server.app.request(`/api/sessions/${session.id}/forms/frm_missing`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: {} }),
    })
    expect(unknown.status).toBe(404)
    expect(await json(unknown)).toMatchObject({ error: { code: "not_found" } })

    const missingSession = await server.app.request("/api/sessions/ses_missing/forms", {
      headers: { cookie },
    })
    expect(missingSession.status).toBe(404)
  })

  it("answers 409 when the form was already replied to", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    const form = server.backend.seedForm(session.id)
    await server.backend.replyForm(session.id, form.id, { summary: "First" })

    const again = await server.app.request(`/api/sessions/${session.id}/forms/${form.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: { summary: "Second" } }),
    })
    // The fake removes a replied form, so a second reply is an unknown id.
    expect(again.status).toBe(404)
    expect(await json(again)).toMatchObject({ error: { code: "not_found" } })
  })
})
