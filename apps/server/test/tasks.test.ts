import { describe, expect, it } from "vitest"
import type { BackgroundJob, Schedule } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

async function post(server: TestServer, path: string, cookie: string, body: unknown = {}): Promise<Response> {
  return server.app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function remove(server: TestServer, path: string, cookie: string): Promise<Response> {
  return server.app.request(path, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  })
}

async function seeded(server: TestServer): Promise<{ cookie: string; id: string }> {
  const session = await server.backend.createSession({ title: "Notes", directory: "/workspace" })
  return { cookie: await login(server), id: session.id }
}

async function schedulesOf(server: TestServer, cookie: string, id: string): Promise<Schedule[]> {
  return json<Schedule[]>(
    await server.app.request(`/api/sessions/${id}/schedules`, { headers: { cookie } }),
  )
}

describe("task routes", () => {
  it("requires a session for every route", async () => {
    const server = makeServer()
    const id = (await server.backend.createSession({ title: "Notes", directory: "/workspace" })).id
    const paths = [
      `/api/sessions/${id}/schedules`,
      "/api/jobs",
      `/api/schedules/${id}/pause`,
      `/api/schedules/${id}/resume`,
    ]
    for (const path of paths) {
      const method = path.includes("/pause") || path.includes("/resume") ? "POST" : "GET"
      const response = await server.app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      })
      expect(response.status).toBe(401)
      expect(await json<{ error: { code: string } }>(response)).toMatchObject({
        error: { code: "unauthorized" },
      })
    }
    const deleted = await remove(server, `/api/schedules/${id}`, "")
    expect(deleted.status).toBe(401)
  })

  it("lists schedules of one session", async () => {
    const server = makeServer()
    const { cookie, id } = await seeded(server)
    await server.backend.createSchedule({
      sessionID: id,
      prompt: "Weekly summary",
      ends: { after: "10 minutes" },
    })

    const response = await server.app.request(`/api/sessions/${id}/schedules`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(await json<Schedule[]>(response)).toMatchObject([
      { sessionID: id, prompt: "Weekly summary", status: "active", runCount: 0 },
    ])
  })

  it("rejects a schedule body without a prompt with 400 invalid_request", async () => {
    const server = makeServer()
    const { cookie, id } = await seeded(server)
    const response = await post(server, `/api/sessions/${id}/schedules`, cookie, {
      ends: { after: "10 minutes" },
    })
    expect(response.status).toBe(400)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "invalid_request" },
    })
    // The rejected body never reached the backend store.
    expect(await schedulesOf(server, cookie, id)).toEqual([])
  })

  it("rejects malformed ends and an unknown session", async () => {
    const server = makeServer()
    const { cookie, id } = await seeded(server)
    for (const body of [
      { prompt: "Run it", ends: {} },
      { prompt: "Run it", ends: { after: "91 days" } },
      { prompt: "Run it", ends: { after: "5 minutes", at: "2026-11-20T09:30" } },
    ]) {
      const response = await post(server, `/api/sessions/${id}/schedules`, cookie, body)
      expect(response.status).toBe(400)
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe("invalid_request")
    }
    const unknown = await post(server, "/api/sessions/ses_unknown/schedules", cookie, {
      prompt: "Run it",
      ends: { after: "5 minutes" },
    })
    expect(unknown.status).toBe(404)
    expect((await json<{ error: { code: string } }>(unknown)).error.code).toBe("not_found")
  })

  it("creates, pauses, resumes and deletes a schedule", async () => {
    const server = makeServer()
    const { cookie, id } = await seeded(server)

    const created = await post(server, `/api/sessions/${id}/schedules`, cookie, {
      prompt: "Weekly summary",
      ends: { at: "2026-11-20T09:30" },
    })
    expect(created.status).toBe(201)
    const row = await json<Schedule>(created)
    expect(row).toMatchObject({ id: "sch_1", sessionID: id, status: "active" })

    const paused = await post(server, `/api/schedules/${row.id}/pause`, cookie)
    expect(paused.status).toBe(200)
    expect((await json<Schedule>(paused)).status).toBe("paused")
    const resumed = await post(server, `/api/schedules/${row.id}/resume`, cookie)
    expect((await json<Schedule>(resumed)).status).toBe("active")

    const removed = await remove(server, `/api/schedules/${row.id}`, cookie)
    expect(removed.status).toBe(200)
    expect(await json<{ ok: boolean }>(removed)).toEqual({ ok: true })
    expect(await schedulesOf(server, cookie, id)).toEqual([])
  })

  it("returns 404 not_found when pausing an unknown schedule", async () => {
    const server = makeServer()
    const { cookie } = await seeded(server)
    const response = await post(server, "/api/schedules/sch_unknown/pause", cookie)
    expect(response.status).toBe(404)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "not_found" },
    })
  })

  it("lists running jobs first", async () => {
    const seededJobs: BackgroundJob[] = [
      { id: "job_done", sessionID: "ses_one", kind: "shell", status: "completed", started: 2_000 },
      { id: "job_run", sessionID: "ses_one", kind: "subagent", status: "running", started: 1_000 },
    ]
    const server = makeServer({ seedJobs: seededJobs })
    const { cookie } = await seeded(server)
    const response = await server.app.request("/api/jobs", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect((await json<BackgroundJob[]>(response)).map((job) => job.id)).toEqual([
      "job_run",
      "job_done",
    ])
  })
})
