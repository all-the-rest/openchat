import type {
  CreateWorktreeRequest,
  WorktreeInfo,
  WorktreesResponse,
} from "@openchat/contracts"

/** The shared JSON transport from `client.ts`; injected so this file stays
 * independent of the rest of the API surface. */
type Request = <T>(path: string, init?: RequestInit) => Promise<T>

/**
 * Worktree endpoints (spec 06, FR-23). `directory` is a path, so it travels as
 * an encoded query value; `force` is sent as the exact string the BFF accepts.
 * The BFF never forces on its own, so a plain removal that hits uncommitted
 * changes fails with the `worktree_dirty` code.
 */
export function worktreeEndpoints(request: Request) {
  return {
    /** The list plus the project the BFF resolved for its workspace. */
    async worktrees(): Promise<WorktreesResponse> {
      const body = await request<Partial<WorktreesResponse>>("/api/worktrees")
      const worktrees = Array.isArray(body?.worktrees) ? body.worktrees : []
      const projectID = typeof body?.projectID === "string" ? body.projectID : undefined
      return projectID === undefined ? { worktrees } : { projectID, worktrees }
    },

    createWorktree(input: CreateWorktreeRequest): Promise<WorktreeInfo> {
      return request<WorktreeInfo>("/api/worktrees", {
        method: "POST",
        body: JSON.stringify(input),
      })
    },

    removeWorktree(directory: string, force: boolean): Promise<void> {
      const params = new URLSearchParams({ directory, force: force ? "true" : "false" })
      return request<void>(`/api/worktrees?${params.toString()}`, {
        method: "DELETE",
        // The BFF requires a JSON content type on state-changing requests.
        body: JSON.stringify({}),
      })
    },
  }
}
