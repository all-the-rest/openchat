import { describe, expect, it } from "vitest"
import type { AgentInfo, ModelInfo, PermissionRequest, SessionInfo } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"

async function newSession(server: ReturnType<typeof makeServer>, cookie: string): Promise<SessionInfo> {
  const response = await server.app.request("/api/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  })
  return json<SessionInfo>(response)
}

describe("catalogue routes", () => {
  it("passes the model and agent catalogues through the backend", async () => {
    const server = makeServer()
    const cookie = await login(server)

    const models = await server.app.request("/api/models", { headers: { cookie } })
    expect(models.status).toBe(200)
    const catalogue = await json<ModelInfo[]>(models)
    expect(catalogue).toHaveLength(4)
    expect(catalogue[0]).toEqual({
      id: "fake/echo", name: "Fake Echo", providerID: "fake",
      providerName: "Fake Provider", variants: ["fast", "thorough"],
      contextLimit: 128_000,
      capabilities: { tools: true, reasoning: false, image: false },
      status: "active",
    })
    expect(catalogue.some((model) => model.status === "deprecated")).toBe(true)

    const agents = await server.app.request("/api/agents", { headers: { cookie } })
    expect(agents.status).toBe(200)
    expect(await json<AgentInfo[]>(agents)).toEqual([
      { id: "build", name: "Build", description: "Deterministic scenario runner" },
    ])
  })

  it("forwards the persisted model and agent with a prompt", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await newSession(server, cookie)

    const prompt = await server.app.request(`/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        text: "hello", model: "fake/echo", variant: "thorough", agent: "build",
      }),
    })
    expect(prompt.status).toBe(200)

    const recorded = await server.app.request(`/api/__fake/prompt/${session.id}`, {
      headers: { cookie },
    })
    expect(recorded.status).toBe(200)
    expect(await json(recorded)).toEqual({
      text: "hello",
      model: "fake/echo",
      variant: "thorough",
      agent: "build",
    })
  })

  it("rejects an oversized choice at the contract boundary", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const prompt = await server.app.request("/api/sessions/ses_1/prompt", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", model: "x".repeat(201) }),
    })
    expect(prompt.status).toBe(400)
  })
})

describe("permission routes", () => {
  it("lists, answers and clears a request", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await newSession(server, cookie)
    const asked = server.backend.askPermission(session.id, "bash", "Run pnpm test", ["pnpm test"])

    const listed = await server.app.request(`/api/sessions/${session.id}/permissions`, {
      headers: { cookie },
    })
    expect(listed.status).toBe(200)
    expect(await json<{ requests: PermissionRequest[] }>(listed)).toEqual({ requests: [asked] })

    const reply = await server.app.request(
      `/api/sessions/${session.id}/permissions/${asked.id}`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "once" }),
      },
    )
    expect(reply.status).toBe(200)
    const after = await server.app.request(`/api/sessions/${session.id}/permissions`, {
      headers: { cookie },
    })
    expect(await json<{ requests: PermissionRequest[] }>(after)).toEqual({ requests: [] })
  })

  it("rejects an unknown decision with 400", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await newSession(server, cookie)
    const asked = server.backend.askPermission(session.id, "bash", "Run pnpm test")

    const reply = await server.app.request(
      `/api/sessions/${session.id}/permissions/${asked.id}`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      },
    )
    expect(reply.status).toBe(400)
    expect(await json(reply)).toMatchObject({ error: { code: "invalid_request" } })
  })

  it("returns 404 for an unknown permission request", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await newSession(server, cookie)

    const reply = await server.app.request(
      `/api/sessions/${session.id}/permissions/per_missing`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      },
    )
    expect(reply.status).toBe(404)
    expect(await json(reply)).toMatchObject({ error: { code: "not_found" } })
  })
})

describe("route authentication", () => {
  it("requires a session on every new route", async () => {
    const server = makeServer()
    const session = await newSession(server, await login(server))
    const base = `/api/sessions/${session.id}`
    const paths: Array<[string, RequestInit]> = [
      ["/api/models", {}],
      ["/api/agents", {}],
      [`${base}/permissions`, {}],
      [`${base}/permissions/per_1`, { method: "POST", body: "{}" }],
      ["/api/__fake/permission", { method: "POST", body: "{}" }],
      [`/api/__fake/prompt/${session.id}`, {}],
    ]
    for (const [path, init] of paths) {
      const response = await server.app.request(path, {
        ...init,
        headers: { "content-type": "application/json" },
      })
      expect(response.status, path).toBe(401)
    }
  })
})
