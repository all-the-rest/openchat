/**
 * Operator-side eviction of the artifact store. Kept separate from the CLI
 * entry point so planning and the exit-code contract are testable without
 * spawning a process. Importing this module has no side effects.
 *
 * The tool is dry-run by default: it only prints what it would remove. Nothing
 * is deleted until `--apply` is passed, and there is no automatic/background
 * eviction anywhere else.
 */

import { join } from "node:path"
import type { ArtifactMeta } from "@openchat/contracts"
import { ArtifactStore } from "./artifacts-store"
import { ARTIFACT_DIR_NAME } from "./env-artifacts"
import { read } from "./env-parse"

const DAY_MS = 86_400_000

export const EVICT_USAGE =
  "usage: artifacts evict --older-than <days> --keep <n> [--apply]  (dry-run unless --apply)"

export type EvictCliArgs =
  | { kind: "help" }
  | { kind: "run"; olderThanDays: number; keep: number; apply: boolean }

function positiveInt(raw: string, name: string): number {
  if (raw.trim().length === 0) throw new Error(`${name} requires a value`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * Same directory as the BFF: `ARTIFACTS_DIR` when set, otherwise the default
 * under `WORKSPACE_DIR`. Read directly so eviction never requires the server's
 * login credentials. A missing directory simply lists as an empty store.
 */
export function artifactsDirFromEnv(env: Record<string, string | undefined>): string {
  const workspaceDir = read(env, "WORKSPACE_DIR") ?? process.cwd()
  return read(env, "ARTIFACTS_DIR") ?? join(workspaceDir, ARTIFACT_DIR_NAME)
}

/** Parses `evict` flags; a usage error throws and the caller maps it to exit 2. */
export function parseEvictArgs(argv: string[]): EvictCliArgs {
  const args = argv.filter((argument) => argument !== "--")
  if (args.length === 0) throw new Error("missing command")
  if (args[0] === "--help" || args[0] === "-h") return { kind: "help" }
  if (args[0] !== "evict") throw new Error(`unknown command: ${args[0]}`)

  let olderThanDays: number | undefined
  let keep: number | undefined
  let apply = false
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    const value = () => args[index + 1] ?? ""
    switch (argument) {
      case "--older-than":
        olderThanDays = positiveInt(value(), "--older-than")
        index += 1
        break
      case "--keep":
        keep = positiveInt(value(), "--keep")
        index += 1
        break
      case "--apply":
        apply = true
        break
      case "--help":
      case "-h":
        return { kind: "help" }
      default:
        throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (olderThanDays === undefined) throw new Error("missing --older-than")
  if (keep === undefined) throw new Error("missing --keep")
  return { kind: "run", olderThanDays, keep, apply }
}

export interface EvictOptions {
  /** Only artifacts strictly older than this many days are candidates. */
  olderThanDays: number
  /** The newest N artifacts are protected even when they are old. */
  keep: number
}

export interface EvictPlan {
  /** Newest first; protected by `--keep`. */
  keep: ArtifactMeta[]
  /** Newest first; old enough and outside the protected set. */
  remove: ArtifactMeta[]
}

/**
 * Pure planner. The newest `--keep` artifacts are never candidates, no matter
 * their age; among the rest only those created before the cutoff are removed.
 * An unparsable `createdAt` is left alone.
 */
export function planEviction(
  items: readonly ArtifactMeta[],
  now: number,
  options: EvictOptions,
): EvictPlan {
  const sorted = [...items].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
    return left.id.localeCompare(right.id)
  })
  const protectedIds = new Set(sorted.slice(0, options.keep).map((item) => item.id))
  const cutoff = now - options.olderThanDays * DAY_MS
  const remove = sorted.filter(
    (item) => !protectedIds.has(item.id) && Date.parse(item.createdAt) < cutoff,
  )
  return { keep: sorted.filter((item) => protectedIds.has(item.id)), remove }
}

export interface EvictDeps {
  /** Injected clock for a deterministic cutoff; defaults to `Date.now`. */
  now?: () => number
  /** Dry-run by default; only `true` deletes anything. */
  apply?: boolean
  log?: (line: string) => void
  /** Injected deletion, e.g. to assert the filesystem was left untouched. */
  remove?: (id: string) => Promise<void>
}

/** Plans an eviction against the store and prints (and optionally applies) it. */
export async function evictArtifacts(
  store: ArtifactStore,
  options: EvictOptions,
  deps: EvictDeps = {},
): Promise<EvictPlan> {
  const log = deps.log ?? (() => {})
  const now = (deps.now ?? (() => Date.now()))()
  const plan = planEviction(await store.listAll(), now, options)
  for (const item of plan.remove) {
    log(`${deps.apply ? "delete" : "would delete"} ${item.id} (created ${item.createdAt})`)
    if (!deps.apply) continue
    if (deps.remove) await deps.remove(item.id)
    else await store.remove(item.id)
  }
  if (plan.remove.length === 0) {
    log("nothing to evict")
  } else if (deps.apply) {
    log(`evict: deleted ${plan.remove.length} artifact(s)`)
  } else {
    log(`evict: dry run, ${plan.remove.length} artifact(s) would be deleted (no changes made)`)
  }
  return plan
}

export interface EvictCliDeps extends EvictDeps {
  /** Injected store so tests need no env or real directory layout. */
  store?: ArtifactStore
}

/**
 * Operator entry point. Returns the exit code: 0 success or `--help`, 1 a
 * runtime failure, 2 a usage error.
 */
export async function runEvictCli(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: EvictCliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  let args: EvictCliArgs
  try {
    args = parseEvictArgs(argv)
  } catch (failure) {
    log(`error: ${messageOf(failure)}`)
    log(EVICT_USAGE)
    return 2
  }
  if (args.kind === "help") {
    log(EVICT_USAGE)
    return 0
  }

  try {
    let store = deps.store
    if (!store) {
      store = new ArtifactStore({ dir: artifactsDirFromEnv(env) })
    }
    await evictArtifacts(
      store,
      { olderThanDays: args.olderThanDays, keep: args.keep },
      { now: deps.now, apply: args.apply, log, remove: deps.remove },
    )
    return 0
  } catch (failure) {
    log(`error: ${messageOf(failure)}`)
    return 1
  }
}
