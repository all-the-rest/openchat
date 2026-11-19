/**
 * Git worktrees (`/worktrees`, spec 06, FR-23).
 *
 * Explicit ids keep the `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po` and is compiled into `messages.ts`.
 */
import { msg } from "@lingui/core/macro"

export const worktrees = {
  "worktrees.title": msg({ id: "worktrees.title", message: "Worktrees" }),
  "worktrees.description": msg({ id: "worktrees.description", message: "Worktrees of this workspace, read from the host." }),
  "worktrees.note": msg({ id: "worktrees.note", message: "Parallel tasks should each run in their own worktree. Removal is refused while uncommitted changes exist; forcing it discards them." }),
  "worktrees.loading": msg({ id: "worktrees.loading", message: "Loading worktrees…" }),
  "worktrees.loadFailed": msg({ id: "worktrees.loadFailed", message: "Worktrees could not be loaded." }),
  "worktrees.retry": msg({ id: "worktrees.retry", message: "Retry" }),
  "worktrees.empty": msg({ id: "worktrees.empty", message: "No worktrees yet. Create one for a task below." }),
  "worktrees.directory": msg({ id: "worktrees.directory", message: "Directory" }),
  "worktrees.branch": msg({ id: "worktrees.branch", message: "Branch" }),
  "worktrees.branchUnknown": msg({ id: "worktrees.branchUnknown", message: "Branch not reported" }),
  "worktrees.project": msg({ id: "worktrees.project", message: "Project: {project}" }),
  "worktrees.action.remove": msg({ id: "worktrees.action.remove", message: "Remove {directory}" }),
  "worktrees.action.removeShort": msg({ id: "worktrees.action.removeShort", message: "Remove" }),
  "worktrees.create.title": msg({ id: "worktrees.create.title", message: "New worktree" }),
  "worktrees.create.branch": msg({ id: "worktrees.create.branch", message: "Branch" }),
  "worktrees.create.branchHint": msg({ id: "worktrees.create.branchHint", message: "Letters, digits and . _ / - only." }),
  "worktrees.create.from": msg({ id: "worktrees.create.from", message: "Base (optional)" }),
  "worktrees.create.fromHint": msg({ id: "worktrees.create.fromHint", message: "Branch or commit to start from. The host default when empty." }),
  "worktrees.create.name": msg({ id: "worktrees.create.name", message: "Name (optional)" }),
  "worktrees.create.nameHint": msg({ id: "worktrees.create.nameHint", message: "Shown in this list; derived from the branch when empty." }),
  "worktrees.create.submit": msg({ id: "worktrees.create.submit", message: "Create worktree" }),
  "worktrees.create.creating": msg({ id: "worktrees.create.creating", message: "Creating…" }),
  "worktrees.create.created": msg({ id: "worktrees.create.created", message: "Worktree created: {directory} on {branch}." }),
  "worktrees.create.failed": msg({ id: "worktrees.create.failed", message: "The worktree could not be created. Check the branch name." }),
  "worktrees.create.exists": msg({ id: "worktrees.create.exists", message: "A worktree for this branch already exists." }),
  "worktrees.remove.title": msg({ id: "worktrees.remove.title", message: "Remove this worktree?" }),
  "worktrees.remove.body": msg({ id: "worktrees.remove.body", message: "Removing {directory} deletes the working directory; the branch itself stays." }),
  "worktrees.remove.dirtyBody": msg({ id: "worktrees.remove.dirtyBody", message: "The removal is refused while the worktree has uncommitted changes. Forcing it discards those changes permanently." }),
  "worktrees.remove.confirm": msg({ id: "worktrees.remove.confirm", message: "Remove worktree" }),
  "worktrees.remove.force": msg({ id: "worktrees.remove.force", message: "Force removal" }),
  "worktrees.remove.cancel": msg({ id: "worktrees.remove.cancel", message: "Cancel" }),
  "worktrees.remove.busy": msg({ id: "worktrees.remove.busy", message: "Removing…" }),
  "worktrees.remove.failed": msg({ id: "worktrees.remove.failed", message: "The worktree could not be removed." }),
  "worktrees.remove.dirty": msg({ id: "worktrees.remove.dirty", message: "The worktree has uncommitted changes. Force removal discards them." }),
  "worktrees.remove.unknown": msg({ id: "worktrees.remove.unknown", message: "This worktree no longer exists." }),
} as const
