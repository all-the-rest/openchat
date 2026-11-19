import type { Context, Hono } from "hono"
import {
  createWorktreeRequestSchema,
  removeWorktreeQuerySchema,
  WORKTREE_DIRTY_CODE,
} from "@openchat/contracts"
import type { WorktreeInfo, WorktreesResponse } from "@openchat/contracts"
import { BackendError, WorktreeDirtyError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"
import { clientAddress } from "./middleware"
import type { FixedWindowThrottle } from "./throttle"

/** Per-address creation budget: 6 worktrees in a fixed 60 s window. */
export const WORKTREE_CREATE_LIMIT = 6
export const WORKTREE_CREATE_WINDOW_MS = 60_000
/**
 * Worktrees one project may hold. The host does not cap `worktree.create`, so
 * every branch name would otherwise add a checkout to the disk.
 */
export const WORKTREE_MAX_COUNT = 16
/** Stable refusal code the web page maps to a localized hint. */
export const WORKTREE_LIMIT_CODE = "worktree_limit"

export interface WorktreeRouteDeps {
  backend: ChatBackend
  config: EnvConfig
  /** Creation throttle, per client address. */
  createThrottle: FixedWindowThrottle
  /**
   * Project root from `WORKSPACE_DIR`. The host may report it as a worktree;
   * it is the project itself and is never removable as a task worktree.
   */
  workspace?: string
}

/** Fixed upstream text: host messages may carry paths or tokens. */
const UNAVAILABLE = "Worktrees are unavailable"
const TOO_MANY = "Too many worktrees created"
const LIMIT_REACHED = "This project already has the maximum number of worktrees"

function unavailable(c: Context<AppEnv>): Response {
  return jsonError(c, 502, "worktrees_unavailable", UNAVAILABLE)
}

/** A trailing slash names the same directory; the host uses the bare path. */
function normalize(directory: string): string {
  return directory.length > 1 && directory.endsWith("/")
    ? directory.slice(0, -1)
    : directory
}

/**
 * The rows a client may act on: what the host listed, minus the project root.
 * Removal is only ever forwarded for one of these host-reported directories,
 * so a client path can never reach `worktree.remove` unchecked.
 */
function removable(
  worktrees: readonly WorktreeInfo[],
  workspace: string | undefined,
): WorktreeInfo[] {
  const root = workspace === undefined ? undefined : normalize(workspace)
  return worktrees.filter((worktree) => normalize(worktree.directory) !== root)
}

/**
 * `/api/worktrees` (spec 06, FR-23). The host needs a project id; the adapter
 * resolves it from the workspace, so the browser never chooses a project.
 *
 * The routes use fixed error codes and never forward upstream messages:
 * `worktree_invalid`, `worktree_exists`, `worktree_unknown`, `worktree_limit`
 * and the distinct `worktree_dirty` the UI turns into a localized
 * "uncommitted changes" hint.
 */
export function registerWorktreeRoutes(app: Hono<AppEnv>, deps: WorktreeRouteDeps): void {
  const { backend, config, createThrottle, workspace } = deps

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
    c.header("Cache-Control", "no-store")
    const address = clientAddress(c, config.TRUST_PROXY)
    const throttle = createThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", TOO_MANY)
    }

    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = createWorktreeRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "worktree_invalid", invalidMessage(parsed.error))
    }

    // The cap is checked against the host's own list, not a cached counter. A
    // failed list means the cap cannot be proven, so nothing is created.
    let existing: WorktreeInfo[]
    try {
      existing = await backend.listWorktrees()
    } catch {
      return unavailable(c)
    }
    if (removable(existing, workspace).length >= WORKTREE_MAX_COUNT) {
      return jsonError(c, 409, WORKTREE_LIMIT_CODE, LIMIT_REACHED)
    }

    // Every accepted request spends the budget before the host is called, so
    // looping on a duplicate branch cannot create without bound. Validation and
    // cap refusals above never reach the host and never count.
    createThrottle.record(address)
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

    // Resolve containment first: only a directory the host listed may be
    // removed. The listed spelling is forwarded, never the client's one.
    let listed: WorktreeInfo[]
    try {
      listed = await backend.listWorktrees()
    } catch {
      return unavailable(c)
    }
    const target = normalize(parsed.data.directory)
    const match = removable(listed, workspace).find(
      (worktree) => normalize(worktree.directory) === target,
    )
    if (match === undefined) {
      return jsonError(c, 404, "worktree_unknown", "Unknown worktree")
    }

    try {
      await backend.removeWorktree(match.directory, force)
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
