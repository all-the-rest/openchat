import type { Context, Hono } from "hono"
import {
  createWorktreeRequestSchema,
  removeWorktreeQuerySchema,
  WORKTREE_DIRTY_CODE,
} from "@openchat/contracts"
import type { WorktreesResponse } from "@openchat/contracts"
import { BackendError, WorktreeDirtyError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import type { AppEnv } from "./app"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"

export interface WorktreeRouteDeps {
  backend: ChatBackend
}

/** Fixed upstream text: host messages may carry paths or tokens. */
const UNAVAILABLE = "Worktrees are unavailable"

function unavailable(c: Context<AppEnv>): Response {
  return jsonError(c, 502, "worktrees_unavailable", UNAVAILABLE)
}

/**
 * `/api/worktrees` (spec 06, FR-23). The host needs a project id; the adapter
 * resolves it from the workspace, so the browser never chooses a project.
 *
 * The routes use fixed error codes and never forward upstream messages:
 * `worktree_invalid`, `worktree_exists`, `worktree_unknown` and the distinct
 * `worktree_dirty` the UI turns into a localized "uncommitted changes" hint.
 */
export function registerWorktreeRoutes(app: Hono<AppEnv>, deps: WorktreeRouteDeps): void {
  const { backend } = deps

  app.get("/api/worktrees", async (c) => {
    c.header("Cache-Control", "no-store")
    try {
      const worktrees = await backend.listWorktrees()
      const projectID = worktrees.find((worktree) => worktree.projectID !== undefined)?.projectID
      const body: WorktreesResponse =
        projectID === undefined ? { worktrees } : { projectID, worktrees }
      return c.json(body)
    } catch {
      return unavailable(c)
    }
  })

  app.post("/api/worktrees", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = createWorktreeRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "worktree_invalid", invalidMessage(parsed.error))
    }
    try {
      const created = await backend.createWorktree(parsed.data)
      return c.json(created, 201)
    } catch (error) {
      if (error instanceof BackendError) {
        if (error.code === "conflict") {
          return jsonError(c, 409, "worktree_exists", "A worktree for this branch already exists")
        }
        if (error.code === "invalid") {
          return jsonError(c, 400, "worktree_invalid", "The worktree could not be created")
        }
      }
      return unavailable(c)
    }
  })

  // `directory` is a path, so it travels as an encoded query value; `force`
  // must be spelled `true` or `false`, which makes an accidental force
  // impossible. The JSON content-type rule still applies to this DELETE.
  app.delete("/api/worktrees", async (c) => {
    const parsed = removeWorktreeQuerySchema.safeParse({
      directory: c.req.query("directory"),
      force: c.req.query("force"),
    })
    if (!parsed.success) {
      return jsonError(c, 400, "worktree_invalid", invalidMessage(parsed.error))
    }
    const force = parsed.data.force === "true"
    try {
      await backend.removeWorktree(parsed.data.directory, force)
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof WorktreeDirtyError) {
        return jsonError(
          c,
          409,
          WORKTREE_DIRTY_CODE,
          "The worktree has uncommitted changes; force the removal to discard them",
        )
      }
      if (error instanceof BackendError) {
        if (error.code === "not_found") {
          return jsonError(c, 404, "worktree_unknown", "Unknown worktree")
        }
        if (error.code === "invalid") {
          return jsonError(c, 400, "worktree_invalid", "Invalid worktree directory")
        }
      }
      return unavailable(c)
    }
  })
}
