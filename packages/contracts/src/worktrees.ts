import { z } from "zod"

/**
 * Git worktrees of the workspace project (spec 06, FR-23).
 *
 * The pinned host reports only a directory and an optional strategy per
 * worktree (`worktree.list()`), and only the directory on create. The branch is
 * a separate VCS read (`vcs.get()`) and may therefore be absent; the BFF never
 * invents one. `projectID` is what the BFF resolved for its workspace, and
 * `name` is the display name the create call asked for.
 */
export interface WorktreeInfo {
  /** Absolute path of the worktree; also the identifier `remove` takes. */
  directory: string
  /** Current branch, when the host answered the VCS read. */
  branch?: string
  /** Display name passed on create; absent for worktrees the host found. */
  name?: string
  /** Project the BFF runs in, when the host reported a project at all. */
  projectID?: string
  /** Host worktree strategy id, when the host reports one. */
  strategy?: string
}

/** `GET /api/worktrees`: the list plus the project the BFF resolved. */
export interface WorktreesResponse {
  /** Omitted when the host reported no project for the workspace. */
  projectID?: string
  worktrees: WorktreeInfo[]
}

/** Branch names are refs, not free text: no whitespace, no control chars. */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/

export const createWorktreeRequestSchema = z.object({
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(BRANCH_PATTERN, "branch may only contain letters, digits and . _ / -")
    .refine((value) => !value.includes(".."), "branch must not contain ..")
    .refine((value) => !value.startsWith("/") && !value.endsWith("/"), {
      message: "branch must not start or end with /",
    }),
  /** Base ref or commit to branch from; the host default when omitted. */
  from: z.string().trim().min(1).max(200).optional(),
  /** Display name; the host derives one from the branch when omitted. */
  name: z.string().trim().min(1).max(120).optional(),
})

export type CreateWorktreeRequest = z.infer<typeof createWorktreeRequestSchema>

/**
 * Query of `DELETE /api/worktrees`. The directory travels as an encoded query
 * value because a path is not a path segment; `force` is strictly spelled so a
 * typo cannot silently become a forced removal.
 */
export const removeWorktreeQuerySchema = z.object({
  directory: z.string().trim().min(1).max(4096),
  force: z.enum(["true", "false"]).optional(),
})

export type RemoveWorktreeQuery = z.infer<typeof removeWorktreeQuerySchema>

/** Stable error code the BFF uses when a removal hit uncommitted changes. */
export const WORKTREE_DIRTY_CODE = "worktree_dirty"
