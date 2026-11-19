import { describe, expect, it, vi } from "vitest"
import type { FormRequest, SessionInfo } from "@openchat/contracts"
import { BackendError } from "@openchat/opencode"
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

  it("answers 502 when the host cannot rename", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    vi.spyOn(server.backend, "renameSession").mockRejectedValue(
      new BackendError("unavailable", "The host did not answer the rename"),
    )

    const response = await server.app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    })
    expect(response.status).toBe(502)
    expect(await json(response)).toMatchObject({ error: { code: "unavailable" } })
  })

  it("maps an unsupported capability to 501 and preserves the code", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    vi.spyOn(server.backend, "renameSession").mockRejectedValue(
      new BackendError("unsupported", "The host has no rename surface"),
    )

    const response = await server.app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    })
    expect(response.status).toBe(501)
    expect(await json(response)).toMatchObject({ error: { code: "unsupported" } })
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

  it("answers 502 when the host cannot delete", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    vi.spyOn(server.backend, "deleteSession").mockRejectedValue(
      new BackendError("unavailable", "The host did not answer the delete"),
    )

    const response = await server.app.request(`/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(502)
    expect(await json(response)).toMatchObject({ error: { code: "unavailable" } })
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

  it("answers 502 when the host cannot read the form before the reply", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    const form = server.backend.seedForm(session.id)
    vi.spyOn(server.backend, "replyForm").mockRejectedValue(
      new BackendError("unavailable", "The host did not read the form"),
    )

    const response = await server.app.request(`/api/sessions/${session.id}/forms/${form.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: { summary: "Costs" } }),
    })
    expect(response.status).toBe(502)
    expect(await json(response)).toMatchObject({ error: { code: "unavailable" } })
  })

  it("answers 502 when the host does not answer the form reply", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    const form = server.backend.seedForm(session.id)
    vi.spyOn(server.backend, "replyForm").mockRejectedValue(
      new BackendError("unavailable", "The host did not answer the form reply"),
    )

    const response = await server.app.request(`/api/sessions/${session.id}/forms/${form.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: { summary: "Costs" } }),
    })
    // The adapter wraps a host drop; the BFF must not turn it into a 500.
    expect(response.status).toBe(502)
    expect(await json(response)).toMatchObject({ error: { code: "unavailable" } })
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

  it("answers 409 when the host reports the form settled before the reply", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createChat(server, cookie)
    const form = server.backend.seedForm(session.id)
    // A live host settles a form between the adapter's pre-read and its reply;
    // the adapter now classifies that as conflict instead of a dead host.
    vi.spyOn(server.backend, "replyForm").mockRejectedValue(
      new BackendError("conflict", `Form ${form.id} has already been answered`),
    )

    const response = await server.app.request(`/api/sessions/${session.id}/forms/${form.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: { summary: "Costs" } }),
    })
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ error: { code: "conflict" } })
  })
})
