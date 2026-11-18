/**
 * The git reads the release machinery needs. Everything runs with `git -C
 * <root>` so a test can point the script at a throwaway repository without
 * changing the process working directory.
 */
import { spawnSync } from "node:child_process"

export class ReleaseError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export class UsageError extends ReleaseError {
  constructor(message: string) {
    super(message, 2)
  }
}

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export function git(root: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  if (result.error) {
    throw new ReleaseError(`git ${args.join(" ")} failed: ${result.error.message}`)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

export function requireGitRepo(root: string): void {
  const result = git(root, ["rev-parse", "--git-dir"])
  if (result.status !== 0) {
    throw new ReleaseError(`${root} is not a git repository`)
  }
}

/** Paths with uncommitted or untracked changes, one per line. */
export function dirtyPaths(root: string): string[] {
  const result = git(root, ["status", "--porcelain", "--untracked-files=normal"])
  if (result.status !== 0) {
    throw new ReleaseError(`git status failed: ${result.stderr.trim()}`)
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

/** The last tag that looks like a release tag, or null. */
export function lastReleaseTag(root: string, prefix = "v"): string | null {
  const result = git(root, ["describe", "--tags", "--abbrev=0", "--match", `${prefix}[0-9]*`])
  if (result.status !== 0) return null
  const tag = result.stdout.trim()
  return tag.length > 0 ? tag : null
}

export function resolveCommit(root: string, ref: string): string {
  const result = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  if (result.status !== 0) {
    throw new ReleaseError(`unknown revision: ${ref}`)
  }
  return result.stdout.trim()
}

export function tagExists(root: string, tag: string): boolean {
  return git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).status === 0
}

export function isAncestor(root: string, ancestor: string, descendant = "HEAD"): boolean {
  return git(root, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0
}

export interface RawCommit {
  hash: string
  subject: string
  /** Committer date, `YYYY-MM-DD` in the commit's own timezone. */
  date: string
  body: string
}

const FIELD = "\x1f"
const RECORD = "\x1e"

/** Commits in `<from>..HEAD`, oldest first, merges excluded. */
export function commitsSince(root: string, from: string | null): RawCommit[] {
  const range = from === null ? "HEAD" : `${from}..HEAD`
  const result = git(root, [
    "log",
    "--no-merges",
    "--reverse",
    `--format=%H${FIELD}%s${FIELD}%cs${FIELD}%b${RECORD}`,
    range,
  ])
  if (result.status !== 0) {
    throw new ReleaseError(`cannot read the commits since ${from ?? "the first commit"}`)
  }
  const commits: RawCommit[] = []
  for (const record of result.stdout.split(RECORD)) {
    const text = record.replace(/^\n+/, "")
    if (text.trim().length === 0) continue
    const [hash, subject, date, body] = text.split(FIELD)
    if (!hash || subject === undefined) continue
    commits.push({ hash, subject, date: date ?? "", body: (body ?? "").trimEnd() })
  }
  return commits
}
