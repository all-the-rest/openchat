import { describe, expect, it } from "vitest"
import type { WorktreeInfo, WorktreesResponse } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const WORKSPACE = "/workspace"
const SEEDED = `${WORKSPACE}/.worktrees/notes`

async function get(server: TestServer, cookie: string): Promise<Response> {
  return server.app.request("/api/worktrees", { headers: { cookie } })
}

async function create(server: TestServer, cookie: string, body: unknown): Promise<Response> {
  return server.app.request("/api/worktrees", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function remove(server: TestServer, cookie: string, directory: string, force?: boolean): Promise<Response> {
  const params = new URLSearchParams({ directory })
  if (force !== undefined) params.set("force", force ? "true" : "false")
  return server.app.request(`/api/worktrees?${params.toString()}`, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  })
}

describe("worktree routes", () => {
  it("requires a session for every route", async () => {
    const server = makeServer()
    const requests = [
      server.app.request("/api/worktrees"),
      server.app.request("/api/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: "feat/x" }),
      }),
      server.app.request(`/api/worktrees?directory=${encodeURIComponent(SEEDED)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ]
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(401)
      expect(await json<{ error: { code: string } }>(response)).toMatchObject({
        error: { code: "unauthorized" },
      })
    }
  })

  it("lists worktrees and the project the BFF resolved", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await get(server, cookie)
    expect(response.status).toBe(200)
    expect(await json<WorktreesResponse>(response)).toEqual({
      projectID: "proj_fake",
      worktrees: [
        { directory: SEEDED, branch: "feat/notes", name: "notes", projectID: "proj_fake" },
      ],
    })
  })

  it("creates a worktree and rejects a duplicate branch", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const created = await create(server, cookie, { branch: "feat/worktrees", name: "Worktrees" })
    expect(created.status).toBe(201)
    const row = await json<WorktreeInfo>(created)
    expect(row).toMatchObject({
      directory: `${WORKSPACE}/.worktrees/feat-worktrees`,
      branch: "feat/worktrees",
      name: "Worktrees",
      projectID: "proj_fake",
    })

    const list = await json<WorktreesResponse>(await get(server, cookie))
    expect(list.worktrees.map((entry) => entry.directory)).toContain(row.directory)

    const duplicate = await create(server, cookie, { branch: "feat/worktrees" })
    expect(duplicate.status).toBe(409)
    expect(await json<{ error: { code: string } }>(duplicate)).toMatchObject({
      error: { code: "worktree_exists" },
    })
  })

  it("rejects an invalid branch before the backend is called", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await create(server, cookie, { branch: "feat/../main" })
    expect(response.status).toBe(400)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktree_invalid" },
    })
  })

  it("refuses a dirty removal without force and accepts a forced one", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const created = await json<WorktreeInfo>(
      await create(server, cookie, { branch: "feat/dirty" }),
    )
    server.backend.markWorktreeDirty(created.directory)

    const refused = await remove(server, cookie, created.directory, false)
    expect(refused.status).toBe(409)
    expect(await json<{ error: { code: string; message: string } }>(refused)).toMatchObject({
      error: { code: "worktree_dirty" },
    })
    const stillThere = await json<WorktreesResponse>(await get(server, cookie))
    expect(stillThere.worktrees.map((entry) => entry.directory)).toContain(created.directory)

    const forced = await remove(server, cookie, created.directory, true)
    expect(forced.status).toBe(200)
    const after = await json<WorktreesResponse>(await get(server, cookie))
    expect(after.worktrees.map((entry) => entry.directory)).not.toContain(created.directory)
  })

  it("defaults a missing force flag to a plain removal", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const created = await json<WorktreeInfo>(
      await create(server, cookie, { branch: "feat/plain" }),
    )
    server.backend.markWorktreeDirty(created.directory)

    const refused = await remove(server, cookie, created.directory)
    expect(refused.status).toBe(409)
    const after = await json<WorktreesResponse>(await get(server, cookie))
    expect(after.worktrees.map((entry) => entry.directory)).toContain(created.directory)
  })

  it("reports an unknown directory as 404", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await remove(server, cookie, `${WORKSPACE}/.worktrees/missing`, true)
    expect(response.status).toBe(404)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktree_unknown" },
    })
  })

  it("rejects an unknown force spelling", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request(
      `/api/worktrees?directory=${encodeURIComponent(SEEDED)}&force=1`,
      {
        method: "DELETE",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      },
    )
    expect(response.status).toBe(400)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktree_invalid" },
    })
  })
})
