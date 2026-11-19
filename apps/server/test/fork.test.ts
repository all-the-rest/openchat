import { describe, expect, it } from "vitest"
import type { Message, SessionInfo } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"

const PARENT = "ses_subagent_parent"
const BEFORE = "msg_subagent_parent_assistant"

async function fork(
  server: ReturnType<typeof makeServer>,
  cookie: string,
  sessionID: string,
  messageID: unknown,
) {
  return server.app.request(`/api/sessions/${sessionID}/fork`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ messageID }),
  })
}

describe("POST /api/sessions/:id/fork", () => {
  it("returns the new branch and keeps the original session", async () => {
    const server = makeServer({ seedSubagents: true })
    const cookie = await login(server)

    const response = await fork(server, cookie, PARENT, BEFORE)
    expect(response.status).toBe(200)
    const branch = await json<SessionInfo>(response)
    expect(branch.branchOf).toBe(PARENT)
    expect(branch.branchBefore).toBe(BEFORE)
    expect(branch.parentID).toBeUndefined()
    expect(branch.title).toBe("Quarterly report review")

    const history = await json<Message[]>(
      await server.app.request(`/api/sessions/${branch.id}/messages`, { headers: { cookie } }),
    )
    expect(history.map((message) => message.id)).toEqual(["msg_subagent_parent_user"])
    expect(history[0]?.sessionID).toBe(branch.id)

    const original = await json<Message[]>(
      await server.app.request(`/api/sessions/${PARENT}/messages`, { headers: { cookie } }),
    )
    expect(original).toHaveLength(2)
    expect(original[1]?.id).toBe(BEFORE)
  })

  it("answers 404 for an unknown session", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await fork(server, cookie, "ses_missing", "msg_1")
    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({ error: { code: "not_found" } })
  })

  it("answers 400 for an unknown message boundary", async () => {
    const server = makeServer({ seedSubagents: true })
    const cookie = await login(server)
    const response = await fork(server, cookie, PARENT, "msg_missing")
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "invalid_request" } })
  })

  it("validates the body and requires authentication", async () => {
    const server = makeServer({ seedSubagents: true })
    const anonymous = await server.app.request(`/api/sessions/${PARENT}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageID: BEFORE }),
    })
    expect(anonymous.status).toBe(401)

    const cookie = await login(server)
    const invalid = await fork(server, cookie, PARENT, "")
    expect(invalid.status).toBe(400)
    expect(await json(invalid)).toMatchObject({ error: { code: "invalid_request" } })
  })
})
