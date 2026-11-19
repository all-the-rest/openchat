import type { CreateWorktreeRequest, WorktreeInfo } from "@openchat/contracts"
import { BackendError } from "./errors"
import { WorktreeDirtyError } from "./worktree-errors"

/** A seeded worktree, optionally marked as having uncommitted changes. */
export interface FakeWorktreeSeed extends WorktreeInfo {
  dirty?: boolean
}

export interface FakeWorktreeStoreOptions {
  /** Injected workspace; created worktrees live under `<workspace>/.worktrees`. */
  workspace?: string
  /** Project every row reports; the fake has exactly one. */
  projectID?: string
  /**
   * Deterministic rows. The default is one clean worktree so pages and tests
   * never need a host.
   */
  worktrees?: readonly FakeWorktreeSeed[]
}

interface StoredWorktree extends WorktreeInfo {
  dirty: boolean
}

const MAX_BRANCH = 200

/** Filesystem-safe slug for a branch name (`feat/x` → `feat-x`). */
function slug(branch: string): string {
  const clean = branch
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
  return clean.length > 0 ? clean.slice(0, 64) : "worktree"
}

/**
 * In-memory worktree store for the fake backend. It models the two host rules
 * the UI depends on: a branch produces a directory under the workspace, and a
 * tree with uncommitted changes refuses a removal until `force` is set.
 */
export class FakeWorktreeStore {
  private readonly trees = new Map<string, StoredWorktree>()
  private readonly workspace: string
  private readonly projectID: string
  private sequence = 0

  constructor(options: FakeWorktreeStoreOptions = {}) {
    this.workspace = options.workspace ?? "/workspace"
    this.projectID = options.projectID ?? "proj_fake"
    const seeds: readonly FakeWorktreeSeed[] = options.worktrees ?? [
      {
        directory: `${this.workspace}/.worktrees/notes`,
        branch: "feat/notes",
        name: "notes",
      },
    ]
    for (const seed of seeds) {
      this.trees.set(seed.directory, {
        ...seed,
        projectID: seed.projectID ?? this.projectID,
        dirty: seed.dirty ?? false,
      })
    }
  }

  async list(): Promise<WorktreeInfo[]> {
    return [...this.trees.values()]
      .sort((left, right) => left.directory.localeCompare(right.directory))
      .map((tree) => this.visible(tree))
  }

  async create(input: CreateWorktreeRequest): Promise<WorktreeInfo> {
    const branch = input.branch.trim()
    if (branch.length === 0 || branch.length > MAX_BRANCH) {
      throw new BackendError("invalid", "A worktree needs a branch name")
    }
    const directory = `${this.workspace}/.worktrees/${slug(branch)}`
    if (this.trees.has(directory)) {
      throw new BackendError("conflict", `A worktree already exists at ${directory}`)
    }
    this.sequence += 1
    const stored: StoredWorktree = {
      directory,
      branch,
      projectID: this.projectID,
      dirty: false,
    }
    const name = input.name?.trim()
    if (name !== undefined && name.length > 0) stored.name = name
    this.trees.set(directory, stored)
    return this.visible(stored)
  }

  async remove(directory: string, force: boolean): Promise<void> {
    const stored = this.trees.get(directory)
    if (!stored) throw new BackendError("not_found", `Unknown worktree: ${directory}`)
    if (stored.dirty && !force) throw new WorktreeDirtyError()
    this.trees.delete(directory)
  }

  /** Fake-mode control: the next unforced removal of this tree is refused. */
  markDirty(directory: string): void {
    const stored = this.trees.get(directory)
    if (!stored) throw new BackendError("not_found", `Unknown worktree: ${directory}`)
    stored.dirty = true
  }

  /** The uncommitted flag stays a fake detail and never reaches the contract. */
  private visible(stored: StoredWorktree): WorktreeInfo {
    const { dirty: _dirty, ...visible } = stored
    return { ...visible }
  }
}
