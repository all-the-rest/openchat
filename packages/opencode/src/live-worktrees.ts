import type { CreateWorktreeRequest, WorktreeInfo } from "@openchat/contracts"
import type { OpenCodeClient } from "@opencode/client"
import { declaredErrorTag, declaredStatus } from "./declared-errors"
import { BackendError } from "./errors"
import { WorktreeDirtyError } from "./worktree-errors"
import { LiveTaskApi } from "./live-task-api"

const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g
const CREATE_FAILED = "The worktree could not be created"

/** Host text is untrusted JSON: keep one printable line, bounded. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim()
  if (clean.length === 0) return undefined
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

/**
 * The project this deployment runs in. The host stores a canonical path, so a
 * workspace configured with a symlinked or trailing-slash path falls back to
 * the only project the host reports; an empty list is an unsupported surface.
 */
async function resolveProjectID(client: OpenCodeClient, workspace: string): Promise<string> {
  let projects: Awaited<ReturnType<OpenCodeClient["project"]["list"]>>
  try {
    projects = await client.project.list({})
  } catch {
    throw new BackendError("unavailable", "The host did not report its projects")
  }
  const target = trimSlash(workspace)
  const match =
    projects.find((project) => trimSlash(project.canonical) === target) ?? projects[0]
  if (!match) {
    throw new BackendError("unsupported", "The host reports no project for this workspace")
  }
  return match.id
}

/** One branch read; a host without VCS support leaves the field out. */
async function branchOf(client: OpenCodeClient, directory: string): Promise<string | undefined> {
  try {
    const response = await client.vcs.get({ location: { directory } })
    return text(response.data.branch.current, 200)
  } catch {
    return undefined
  }
}

/** Normalizes one host entry; `projectID` and `branch` are filled by the BFF. */
async function describe(
  client: OpenCodeClient,
  projectID: string,
  entry: { directory: string; strategy?: string },
): Promise<WorktreeInfo> {
  const info: WorktreeInfo = { directory: entry.directory, projectID }
  const strategy = text(entry.strategy, 80)
  if (strategy !== undefined) info.strategy = strategy
  const branch = await branchOf(client, entry.directory)
  if (branch !== undefined) info.branch = branch
  return info
}

/** One object's own flag: the declared `data` envelope first, then the flat body. */
function ownFlag(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object") return undefined
  const record = value as { forceRequired?: unknown; data?: unknown }
  if (record.forceRequired === true || record.forceRequired === false) return record.forceRequired
  const data = record.data
  if (data === null || typeof data !== "object") return undefined
  const nested = (data as { forceRequired?: unknown }).forceRequired
  return nested === true || nested === false ? nested : undefined
}

/**
 * Whether a host removal refusal carries the structured `forceRequired` flag.
 *
 * The declared `WorktreeError` body is `{ _tag, name, data: { message,
 * forceRequired? } }`, and the promise client assigns that body onto an `Error`
 * (see `declared` in the contract chunk), so the flag lives under `data` on the
 * top-level object. A flat `forceRequired` and wrapper `cause` shapes are read
 * too, so a differently built rejection is not misread as an unavailable host.
 * The `WorktreeError` tag alone is not dirty evidence: without the flag it is
 * the host's generic removal refusal.
 */
function forceRequired(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== "object") return false
    const flag = ownFlag(current)
    if (flag !== undefined) return flag
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Classifies a create rejection by what the host declared. `WorktreeError` is
 * the host's own domain refusal (the branch or worktree exists, git refused)
 * and, like `InvalidRequestError`, maps to a rejected request. A declared
 * status is decoded into a tagged error without a status field, so only an
 * undeclared `UnexpectedStatus` can carry one: its 409 would be the host's
 * "already exists" answer (the BFF turns it into `409 worktree_exists`). A
 * transport failure, timeout, 5xx or malformed body is an unavailable host and
 * must not surface as a bad branch name in the UI.
 */
function createError(error: unknown): BackendError {
  const status = declaredStatus(error)
  if (status === 409) return new BackendError("conflict", CREATE_FAILED)
  if (status === 404) return new BackendError("not_found", CREATE_FAILED)
  if (status !== undefined && status >= 400 && status < 500) {
    return new BackendError("invalid", CREATE_FAILED)
  }
  if (status === undefined) {
    const tag = declaredErrorTag(error)
    if (tag === "WorktreeError" || tag === "InvalidRequestError") {
      return new BackendError("invalid", CREATE_FAILED)
    }
    if (tag === "ProjectNotFoundError") return new BackendError("not_found", CREATE_FAILED)
  }
  return new BackendError("unavailable", CREATE_FAILED)
}

/**
 * Worktree methods of the live backend. Grouped with the task adapter so
 * `live.ts` stays within the file-length budget; the host client and the
 * workspace come from the shared adapter base.
 */
export class LiveWorktreeApi extends LiveTaskApi {
  constructor(
    client: OpenCodeClient,
    private readonly worktreeWorkspace: string,
  ) {
    super(client)
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const projectID = await resolveProjectID(this.client, this.worktreeWorkspace)
    try {
      const rows = await this.client.worktree.list({ projectID })
      return await Promise.all(rows.map((row) => describe(this.client, projectID, row)))
    } catch (error) {
      if (error instanceof BackendError) throw error
      throw new BackendError("unavailable", "Worktrees could not be listed")
    }
  }

  async createWorktree(input: CreateWorktreeRequest): Promise<WorktreeInfo> {
    const projectID = await resolveProjectID(this.client, this.worktreeWorkspace)
    let created: { directory: string }
    try {
      created = await this.client.worktree.create({
        projectID,
        branch: input.branch,
        from: input.from,
        name: input.name,
      })
    } catch (error) {
      throw createError(error)
    }
    const info: WorktreeInfo = {
      directory: created.directory,
      projectID,
      branch: (await branchOf(this.client, created.directory)) ?? input.branch,
    }
    const name = text(input.name, 120)
    if (name !== undefined) info.name = name
    return info
  }

  async removeWorktree(directory: string, force: boolean): Promise<void> {
    const projectID = await resolveProjectID(this.client, this.worktreeWorkspace)
    try {
      await this.client.worktree.remove({ projectID, directory, force })
    } catch (error) {
      // A dirty tree is never removed silently: a refusal that declares
      // `forceRequired` is surfaced so the owner can confirm a forced removal
      // in the UI. A `WorktreeError` without the flag stays a generic refusal,
      // and `force: true` above already bypassed the check.
      if (!force && forceRequired(error)) throw new WorktreeDirtyError()
      throw new BackendError("unavailable", "The worktree could not be removed")
    }
  }
}
