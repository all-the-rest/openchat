import { describe, expect, it, vi } from "vitest"
import type { OpenCodeClient } from "@opencode/client"
import { BackendError, FakeBackend, WorktreeDirtyError } from "../src"
import { LiveBackend } from "../src/live"

const WORKSPACE = "/workspace"

/** Minimal host client for the worktree adapter; no request leaves the test. */
function liveClient() {
  return {
    project: {
      list: vi.fn(async () => [
        { id: "proj_1", canonical: WORKSPACE, sandboxes: [], time: { created: 1, updated: 1, active: 1 } },
      ]),
    },
    worktree: {
      list: vi.fn(async () => [
        { directory: `${WORKSPACE}/.worktrees/a`, strategy: "local" },
        { directory: `${WORKSPACE}/.worktrees/b` },
      ]),
      create: vi.fn(async () => ({ directory: `${WORKSPACE}/.worktrees/new` })),
      remove: vi.fn(async () => undefined),
    },
    vcs: {
      get: vi.fn(async ({ location }: { location?: { directory?: string } }) => ({
        location: { directory: location?.directory ?? WORKSPACE },
        data: { branch: { current: location?.directory?.endsWith("/a") ? "feat/a" : "feat/b" } },
      })),
    },
  } as unknown as OpenCodeClient
}

function liveBackend(client: OpenCodeClient) {
  return new LiveBackend({
    baseUrl: "http://unused",
    password: "unused",
    workspace: WORKSPACE,
    client,
  })
}

/** The create mock of the minimal client, typed for `mockRejectedValueOnce`. */
function createMock(client: OpenCodeClient) {
  return client.worktree as unknown as { create: ReturnType<typeof vi.fn> }
}

/** The wire body the pinned promise client assigns onto an `Error`. */
const DIRTY_REFUSAL = {
  _tag: "WorktreeError",
  name: "WorktreeError",
  data: { message: "worktree has uncommitted changes", forceRequired: true },
}

const PLAIN_REFUSAL = {
  _tag: "WorktreeError",
  name: "WorktreeError",
  data: { message: "worktree could not be removed" },
}

describe("fake worktrees", () => {
  it("seeds one worktree so a page needs no host", async () => {
    const backend = new FakeBackend({ workspace: WORKSPACE })
    expect(await backend.listWorktrees()).toEqual([
      {
        directory: `${WORKSPACE}/.worktrees/notes`,
        branch: "feat/notes",
        name: "notes",
        projectID: "proj_fake",
      },
    ])
  })

  it("creates a worktree with a directory derived from the branch", async () => {
    const backend = new FakeBackend({ workspace: WORKSPACE })
    const created = await backend.createWorktree({
      branch: "feat/worktrees",
      name: "Worktrees",
    })
    expect(created).toEqual({
      directory: `${WORKSPACE}/.worktrees/feat-worktrees`,
      branch: "feat/worktrees",
      name: "Worktrees",
      projectID: "proj_fake",
    })

    const rows = await backend.listWorktrees()
    expect(rows.map((row) => row.directory)).toEqual([
      `${WORKSPACE}/.worktrees/feat-worktrees`,
      `${WORKSPACE}/.worktrees/notes`,
    ])
  })

  it("refuses a second worktree for the same branch", async () => {
    const backend = new FakeBackend({ workspace: WORKSPACE })
    await backend.createWorktree({ branch: "feat/worktrees" })
    await expect(backend.createWorktree({ branch: "feat/worktrees" })).rejects.toMatchObject({
      code: "conflict",
    })
  })

  it("refuses an unknown directory with not_found", async () => {
    const backend = new FakeBackend({ workspace: WORKSPACE })
    const error = await backend.removeWorktree("/workspace/.worktrees/nope", false).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: "not_found" })
  })

  it("refuses a dirty removal without force and accepts it with force", async () => {
    const backend = new FakeBackend({ workspace: WORKSPACE })
    const created = await backend.createWorktree({ branch: "feat/dirty" })
    backend.markWorktreeDirty(created.directory)

    const refused = await backend.removeWorktree(created.directory, false).catch(
      (caught: unknown) => caught,
    )
    expect(refused).toBeInstanceOf(WorktreeDirtyError)
    expect(refused).toMatchObject({ code: "conflict" })
    // The refusal did not remove anything.
    expect(await backend.listWorktrees()).toEqual(
      expect.arrayContaining([expect.objectContaining({ directory: created.directory })]),
    )

    await backend.removeWorktree(created.directory, true)
    expect(await backend.listWorktrees()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ directory: created.directory })]),
    )
  })
})

describe("live worktrees", () => {
  it("resolves the host project and fills the branch from the VCS read", async () => {
    const client = liveClient()
    const backend = liveBackend(client)

    expect(await backend.listWorktrees()).toEqual([
      {
        directory: `${WORKSPACE}/.worktrees/a`,
        projectID: "proj_1",
        strategy: "local",
        branch: "feat/a",
      },
      { directory: `${WORKSPACE}/.worktrees/b`, projectID: "proj_1", branch: "feat/b" },
    ])
    expect(client.project.list).toHaveBeenCalledTimes(1)
    expect(client.worktree.list).toHaveBeenCalledWith({ projectID: "proj_1" })
  })

  it("omits the branch when the host cannot answer the VCS read", async () => {
    const client = liveClient()
    const vcs = client.vcs as unknown as { get: ReturnType<typeof vi.fn> }
    vcs.get.mockRejectedValue(new Error("no vcs"))
    const backend = liveBackend(client)

    const rows = await backend.listWorktrees()
    expect(rows[0]).not.toHaveProperty("branch")
  })

  it("surfaces the host's uncommitted-changes refusal and never forces", async () => {
    const client = liveClient()
    const worktree = client.worktree as unknown as { remove: ReturnType<typeof vi.fn> }
    // The host refuses an unforced removal of a dirty tree; a forced one succeeds.
    worktree.remove.mockImplementation(async ({ force }: { force?: boolean }) => {
      if (!force) throw DIRTY_REFUSAL
      return undefined
    })
    const backend = liveBackend(client)

    await expect(backend.removeWorktree(`${WORKSPACE}/.worktrees/a`, false)).rejects.toBeInstanceOf(
      WorktreeDirtyError,
    )
    // The adapter never retried with force.
    expect(worktree.remove).toHaveBeenCalledTimes(1)
    expect(worktree.remove).toHaveBeenLastCalledWith({
      projectID: "proj_1",
      directory: `${WORKSPACE}/.worktrees/a`,
      force: false,
    })

    await backend.removeWorktree(`${WORKSPACE}/.worktrees/a`, true)
    expect(worktree.remove).toHaveBeenLastCalledWith({
      projectID: "proj_1",
      directory: `${WORKSPACE}/.worktrees/a`,
      force: true,
    })
  })

  it("reads a flat forceRequired flag as the dirty refusal too", async () => {
    const client = liveClient()
    const worktree = client.worktree as unknown as { remove: ReturnType<typeof vi.fn> }
    worktree.remove.mockRejectedValueOnce({ forceRequired: true })
    const backend = liveBackend(client)

    await expect(backend.removeWorktree(`${WORKSPACE}/.worktrees/a`, false)).rejects.toBeInstanceOf(
      WorktreeDirtyError,
    )
  })

  it("rejects a removal the host refuses for another reason", async () => {
    const client = liveClient()
    const worktree = client.worktree as unknown as { remove: ReturnType<typeof vi.fn> }
    // A `WorktreeError` without the structured flag is a generic refusal.
    worktree.remove.mockRejectedValueOnce(PLAIN_REFUSAL)
    const backend = liveBackend(client)

    const error = await backend.removeWorktree(`${WORKSPACE}/.worktrees/a`, false).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BackendError)
    expect(error).not.toBeInstanceOf(WorktreeDirtyError)
    expect(error).toMatchObject({ code: "unavailable" })
  })

  it("maps a transport failure on create to unavailable", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce(new Error("socket hang up"))
    const backend = liveBackend(client)

    const error = await backend.createWorktree({ branch: "feat/new" }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: "unavailable" })
  })

  it("maps an undeclared 409 on create to conflict", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce({
      reason: "UnexpectedStatus",
      cause: { status: 409 },
    })
    const backend = liveBackend(client)

    await expect(backend.createWorktree({ branch: "feat/taken" })).rejects.toMatchObject({
      code: "conflict",
    })
  })

  it("maps the host's WorktreeError refusal on create to invalid", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce({
      _tag: "WorktreeError",
      name: "WorktreeError",
      data: { message: "branch already exists" },
    })
    const backend = liveBackend(client)

    await expect(backend.createWorktree({ branch: "feat/taken" })).rejects.toMatchObject({
      code: "invalid",
    })
  })

  it("maps a declared InvalidRequestError on create to invalid", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce({
      _tag: "InvalidRequestError",
      message: "invalid branch",
    })
    const backend = liveBackend(client)

    await expect(backend.createWorktree({ branch: "feat/bad" })).rejects.toMatchObject({
      code: "invalid",
    })
  })

  it("maps a declared ProjectNotFoundError on create to not_found", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce({
      _tag: "ProjectNotFoundError",
      projectID: "proj_1",
      message: "no such project",
    })
    const backend = liveBackend(client)

    await expect(backend.createWorktree({ branch: "feat/new" })).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("maps another declared 4xx on create to invalid", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce({
      reason: "UnexpectedStatus",
      cause: { status: 422 },
    })
    const backend = liveBackend(client)

    await expect(backend.createWorktree({ branch: "feat/bad" })).rejects.toMatchObject({
      code: "invalid",
    })
  })

  it("maps a declared 5xx on create to unavailable", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce({
      reason: "UnexpectedStatus",
      cause: { status: 503 },
    })
    const backend = liveBackend(client)

    await expect(backend.createWorktree({ branch: "feat/new" })).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("maps a malformed create rejection to unavailable", async () => {
    const client = liveClient()
    createMock(client).create.mockRejectedValueOnce({ reason: "MalformedResponse", cause: {} })
    const backend = liveBackend(client)

    await expect(backend.createWorktree({ branch: "feat/new" })).rejects.toMatchObject({
      code: "unavailable",
    })
  })
})
