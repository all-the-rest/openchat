import { BackendError } from "./errors"

/**
 * The host refused to remove a worktree because it still has uncommitted
 * changes. The distinct subclass lets the BFF answer with a stable, localizable
 * code while the adapter never retries with `force: true` on its own.
 */
export class WorktreeDirtyError extends BackendError {
  constructor(message = "The worktree has uncommitted changes") {
    super("conflict", message)
    this.name = "WorktreeDirtyError"
  }
}
