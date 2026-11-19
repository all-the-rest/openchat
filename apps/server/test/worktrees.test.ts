import { describe, expect, it, vi } from "vitest"
import type { WorktreeInfo, WorktreesResponse } from "@openchat/contracts"
import { BackendError } from "@openchat/opencode"
import { FixedWindowThrottle } from "../src/throttle"
import { WORKTREE_LIMIT_CODE } from "../src/worktrees"
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
    const removeSpy = vi.spyOn(server.backend, "removeWorktree")
    const response = await remove(server, cookie, `${WORKSPACE}/.worktrees/missing`, true)
    expect(response.status).toBe(404)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktree_unknown" },
    })
    // A path the host never listed must not reach the removal at all.
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it("removes a listed directory and accepts a trailing slash", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const removeSpy = vi.spyOn(server.backend, "removeWorktree")

    const response = await remove(server, cookie, `${SEEDED}/`, false)

    expect(response.status).toBe(200)
    // The host's own spelling is forwarded, not the client's one.
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledWith(SEEDED, false)
  })

  it("refuses a removal as 502 when the worktree list is unavailable", async () => {
    const server = makeServer()
    const cookie = await login(server)
    vi.spyOn(server.backend, "listWorktrees").mockRejectedValue(new Error("host down"))
    const removeSpy = vi.spyOn(server.backend, "removeWorktree")

    const response = await remove(server, cookie, SEEDED, false)

    expect(response.status).toBe(502)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktrees_unavailable" },
    })
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it("refuses the project root even when the host lists it", async () => {
    const server = makeServer()
    const cookie = await login(server)
    vi.spyOn(server.backend, "listWorktrees").mockResolvedValue([
      { directory: WORKSPACE, projectID: "proj_fake" },
      { directory: SEEDED, projectID: "proj_fake" },
    ])
    const removeSpy = vi.spyOn(server.backend, "removeWorktree")

    const response = await remove(server, cookie, WORKSPACE, true)

    expect(response.status).toBe(404)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktree_unknown" },
    })
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it("throttles creation per address with a Retry-After", async () => {
    const throttle = new FixedWindowThrottle({
      limit: 2,
      windowMs: 60_000,
      now: () => 0,
    })
    const server = makeServer({ worktreeThrottle: throttle })
    const cookie = await login(server)

    expect((await create(server, cookie, { branch: "feat/one" })).status).toBe(201)
    expect((await create(server, cookie, { branch: "feat/two" })).status).toBe(201)

    const limited = await create(server, cookie, { branch: "feat/three" })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    expect(await json<{ error: { code: string } }>(limited)).toMatchObject({
      error: { code: "too_many_requests" },
    })
  })

  it("does not charge the throttle for a rejected create body", async () => {
    const throttle = new FixedWindowThrottle({
      limit: 1,
      windowMs: 60_000,
      now: () => 0,
    })
    const server = makeServer({ worktreeThrottle: throttle })
    const cookie = await login(server)

    const invalid = await create(server, cookie, { branch: "feat/../main" })
    expect(invalid.status).toBe(400)
    expect(await json<{ error: { code: string } }>(invalid)).toMatchObject({
      error: { code: "worktree_invalid" },
    })
    // The body is rejected before the budget is spent: `app.request` has no
    // socket peer, so the route sees the `local` address. With one permit the
    // check turns limited only after a recorded create.
    expect(throttle.check("local").limited).toBe(false)

    expect((await create(server, cookie, { branch: "feat/valid" })).status).toBe(201)
    expect(throttle.check("local").limited).toBe(true)
    expect((await create(server, cookie, { branch: "feat/later" })).status).toBe(429)
  })

  it("counts repeated conflicting creates against the budget", async () => {
    const throttle = new FixedWindowThrottle({
      limit: 2,
      windowMs: 60_000,
      now: () => 0,
    })
    const server = makeServer({ worktreeThrottle: throttle })
    const cookie = await login(server)
    // Seed the conflict through the backend so every HTTP attempt is a
    // duplicate; each one must still spend the caller's budget.
    await server.backend.createWorktree({ branch: "feat/taken" })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const conflict = await create(server, cookie, { branch: "feat/taken" })
      expect(conflict.status).toBe(409)
      expect(await json<{ error: { code: string } }>(conflict)).toMatchObject({
        error: { code: "worktree_exists" },
      })
    }

    const limited = await create(server, cookie, { branch: "feat/taken" })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    expect(await json<{ error: { code: string } }>(limited)).toMatchObject({
      error: { code: "too_many_requests" },
    })
  })

  it("refuses the seventeenth worktree with worktree_limit", async () => {
    // Sixteen permits equal the cap, so fifteen accepted creates leave the
    // budget one short: a cap refusal that spent it would answer 429 next.
    const throttle = new FixedWindowThrottle({
      limit: 16,
      windowMs: 60_000,
      now: () => 0,
    })
    const server = makeServer({ worktreeThrottle: throttle })
    const cookie = await login(server)
    const createSpy = vi.spyOn(server.backend, "createWorktree")

    // The fake seeds one worktree; fifteen more fill the project to sixteen.
    for (let index = 0; index < 15; index += 1) {
      const response = await create(server, cookie, { branch: `feat/cap-${index}` })
      expect(response.status).toBe(201)
    }
    const list = await json<WorktreesResponse>(await get(server, cookie))
    expect(list.worktrees).toHaveLength(16)

    const refused = await create(server, cookie, { branch: "feat/cap-over" })
    expect(refused.status).toBe(409)
    expect(await json<{ error: { code: string } }>(refused)).toMatchObject({
      error: { code: WORKTREE_LIMIT_CODE },
    })
    // The cap is checked before the budget is spent, so a second refusal still
    // reaches the cap instead of answering 429.
    const refusedAgain = await create(server, cookie, { branch: "feat/cap-again" })
    expect(refusedAgain.status).toBe(409)
    expect(throttle.check("local").limited).toBe(false)
    expect(createSpy).toHaveBeenCalledTimes(15)
  })

  it("refuses to create as 502 when the worktree list is unavailable", async () => {
    const server = makeServer()
    const cookie = await login(server)
    vi.spyOn(server.backend, "listWorktrees").mockRejectedValue(new Error("host down"))
    const createSpy = vi.spyOn(server.backend, "createWorktree")

    const response = await create(server, cookie, { branch: "feat/unlisted" })

    expect(response.status).toBe(502)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktrees_unavailable" },
    })
    expect(createSpy).not.toHaveBeenCalled()
  })

  it("answers 502, not 404, when create reports a vanished project", async () => {
    // The adapter reports `not_found` when the workspace project is gone; the
    // create surface cannot proceed without it, so it stays `worktrees_unavailable`.
    const server = makeServer()
    const cookie = await login(server)
    vi.spyOn(server.backend, "createWorktree").mockRejectedValue(
      new BackendError("not_found", "The project is gone"),
    )

    const response = await create(server, cookie, { branch: "feat/orphan" })

    expect(response.status).toBe(502)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "worktrees_unavailable" },
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
