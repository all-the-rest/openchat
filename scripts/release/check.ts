/**
 * `release:check`: the pre-tag gate. Cheap local invariants first (dirty tree,
 * version agreement, changelog-vs-tag), then `gates:fast`, `ratchet verify`
 * when the config declares it, and optionally the Playwright suite.
 *
 * The tag check runs before the tag exists (that is the point of a pre-release
 * check): no `v<version>` tag is required, but a tag that does exist must name
 * the version in `VERSION` and be an ancestor of `HEAD`.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CHANGELOG_FILE } from "./config.ts"
import { hasVersion, readChangelog } from "./changelog.ts"
import {
  dirtyPaths,
  isAncestor,
  ReleaseError,
  requireGitRepo,
  tagExists,
} from "./git.ts"
import { checkAgreement, readState } from "./version.ts"

export interface CheckOptions {
  root: string
  skipGates: boolean
  skipVerify: boolean
  withE2e: boolean
  tag?: string
}

const VERIFY_KEY_RE = /(^|[\s,{[])"verify"\s*:/

/** Whether a ratchet config in the root declares a `verify` section. */
export function configHasVerify(root: string): boolean {
  for (const name of ["ratchet.config.jsonc", "ratchet.config.json"]) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const text = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    if (VERIFY_KEY_RE.test(text)) return true
  }
  return false
}

function run(root: string, label: string, command: string, args: string[]): boolean {
  console.log(`release check: ${label}: ${command} ${args.join(" ")}`)
  const result = spawnStep(command, args, root)
  if (result !== 0) {
    console.error(`release check: ${label} failed with exit ${result}`)
    return false
  }
  return true
}

/**
 * Spawn with the caller's stdio so a failing gate explains itself. Kept in one
 * place so the tests can prepend a fake `pnpm`/`ratchet` to PATH.
 */
function spawnStep(command: string, args: string[], root: string): number {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  })
  if (result.error) {
    console.error(`release check: cannot run ${command}: ${result.error.message}`)
    return 127
  }
  return result.status ?? 1
}

export function runCheck(options: CheckOptions): number {
  const { root } = options
  requireGitRepo(root)

  const dirty = dirtyPaths(root)
  if (dirty.length > 0) {
    console.error("release check: the working tree is dirty; commit or stash first:")
    for (const line of dirty) console.error(`  ${line}`)
    return 1
  }

  const state = readState(root)
  const problems = checkAgreement(state)
  if (!hasVersion(readChangelog(root), state.version)) {
    problems.push(`${CHANGELOG_FILE} has no "## [${state.version}]" section`)
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`release check: ${problem}`)
    return 1
  }

  const tag = options.tag ?? `v${state.version}`
  const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag
  if (tagVersion !== state.version) {
    console.error(
      `release check: tag ${tag} says ${tagVersion}, but VERSION says ${state.version}`,
    )
    return 1
  }
  if (tagExists(root, tag) && !isAncestor(root, tag)) {
    console.error(`release check: tag ${tag} is not an ancestor of HEAD`)
    return 1
  }

  if (!options.skipGates && !run(root, "gates", "pnpm", ["run", "gates:fast"])) return 1

  if (!options.skipVerify && configHasVerify(root)) {
    if (!run(root, "verify", "ratchet", ["verify"])) return 1
  }

  if (options.withE2e && !run(root, "e2e", "pnpm", ["run", "test:e2e"])) return 1

  console.log(`release check: ok for ${state.version} (${state.packages.length} packages)`)
  return 0
}

export function describeFailure(error: unknown): number {
  if (error instanceof ReleaseError) {
    console.error(`release: ${error.message}`)
    return error.exitCode
  }
  console.error(`release: ${(error as Error).message}`)
  return 1
}
