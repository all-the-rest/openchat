#!/usr/bin/env node
/**
 * Release mechanics: one version, one changelog, one pre-tag check.
 *
 *   node scripts/release.ts version
 *   node scripts/release.ts bump --minor [--dry-run] [--allow-dirty]
 *   node scripts/release.ts changelog [--version X.Y.Z] [--from REF] [--date YYYY-MM-DD] [--dry-run]
 *   node scripts/release.ts check [--skip-gates] [--skip-verify] [--with-e2e] [--tag vX.Y.Z]
 *
 * `bump` is the only command that writes the version, and it writes it to every
 * place that must agree. `changelog` is deterministic: history date, Keep a
 * Changelog section order, issue references from `Refs`/`Closes`/`Fixes`.
 */
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  CHANGELOG_FILE,
  VERSION_FILE,
} from "./release/config.ts"
import {
  buildChangelog,
  requireVersion,
  resolveDate,
} from "./release/changelog.ts"
import { describeFailure, runCheck } from "./release/check.ts"
import {
  commitsSince,
  dirtyPaths,
  lastReleaseTag,
  ReleaseError,
  requireGitRepo,
  resolveCommit,
  UsageError,
} from "./release/git.ts"
import {
  applyChanges,
  bumpVersion,
  parseSemver,
  planBump,
  readState,
  readVersionFile,
} from "./release/version.ts"
import type { BumpKind } from "./release/version.ts"

const ROOT = resolve(import.meta.dirname, "..")

interface OptionSpec {
  booleans: string[]
  values: string[]
}

interface Options {
  flags: Set<string>
  values: Map<string, string>
  positional: string[]
}

function parseOptions(args: string[], spec: OptionSpec): Options {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positional: string[] = []
  const booleanNames = new Set(spec.booleans)
  const valueNames = new Set(spec.values)
  // `pnpm run release:bump -- --patch` forwards the separator itself; a lone
  // leading `--` is the package manager's convention, not an option terminator.
  const list = args[0] === "--" ? args.slice(1) : args
  for (let index = 0; index < list.length; index += 1) {
    const argument = list[index] ?? ""
    if (argument === "--") {
      positional.push(...list.slice(index + 1))
      break
    }
    if (!argument.startsWith("--")) {
      positional.push(argument)
      continue
    }
    const equals = argument.indexOf("=")
    const name = (equals === -1 ? argument.slice(2) : argument.slice(2, equals))
    if (booleanNames.has(name)) {
      if (equals !== -1) throw new UsageError(`--${name} takes no value`)
      flags.add(name)
      continue
    }
    if (valueNames.has(name)) {
      if (equals !== -1) {
        values.set(name, argument.slice(equals + 1))
        continue
      }
      const value = list[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} needs a value`)
      }
      values.set(name, value)
      index += 1
      continue
    }
    throw new UsageError(`unknown option: ${argument}`)
  }
  return { flags, values, positional }
}

function expectNoPositionals(options: Options): void {
  if (options.positional.length > 0) {
    throw new UsageError(`unexpected argument: ${options.positional.join(" ")}`)
  }
}

function rootOf(options: Options): string {
  const root = options.values.get("root")
  return root === undefined ? ROOT : resolve(root)
}

function commandVersion(args: string[]): number {
  const options = parseOptions(args, { booleans: [], values: ["root"] })
  expectNoPositionals(options)
  console.log(readVersionFile(rootOf(options)))
  return 0
}

function commandBump(args: string[]): number {
  const options = parseOptions(args, {
    booleans: ["major", "minor", "patch", "dry-run", "allow-dirty"],
    values: ["set", "root"],
  })
  expectNoPositionals(options)
  const kinds: BumpKind[] = ["major", "minor", "patch"]
  const selected = kinds.filter((kind) => options.flags.has(kind))
  const set = options.values.get("set")
  if (selected.length + (set === undefined ? 0 : 1) !== 1) {
    throw new UsageError("bump needs exactly one of --major, --minor, --patch or --set X.Y.Z")
  }
  const root = rootOf(options)
  requireGitRepo(root)
  if (!options.flags.has("allow-dirty")) {
    const dirty = dirtyPaths(root)
    if (dirty.length > 0) {
      throw new ReleaseError(
        `the working tree is dirty; commit or stash first (${dirty.length} path(s); --allow-dirty overrides)`,
      )
    }
  }

  const state = readState(root)
  const kind = selected[0]
  const next =
    set !== undefined
      ? requireVersion(set)
      : kind === undefined
        ? ""
        : bumpVersion(state.version, kind)
  if (next === state.version) {
    throw new UsageError(`already at ${next}`)
  }
  if (!parseSemver(next)) throw new UsageError(`not a version: ${next}`)
  const changes = planBump(root, state, next)
  applyChanges(root, changes, options.flags.has("dry-run"))
  const prefix = options.flags.has("dry-run") ? "would bump" : "bumped"
  console.log(`${prefix}: ${state.version} -> ${next} (${changes.length} files)`)
  return 0
}

function commandChangelog(args: string[]): number {
  const options = parseOptions(args, {
    booleans: ["dry-run"],
    values: ["version", "from", "date", "root"],
  })
  expectNoPositionals(options)
  const root = rootOf(options)
  requireGitRepo(root)
  const version = requireVersion(options.values.get("version") ?? readVersionFile(root))

  const fromArg = options.values.get("from")
  const from = fromArg !== undefined ? resolveCommit(root, fromArg) : lastReleaseTag(root)
  const commits = commitsSince(root, from)
  if (commits.length === 0) {
    console.log(`no commits since ${from ?? "the first commit"}; nothing to write`)
    return 0
  }
  const newest = commits[commits.length - 1]
  const date = resolveDate(options.values.get("date"), newest?.date ?? "")
  const result = buildChangelog(root, commits, version, date)
  if (result === null) {
    console.log(`no changelog entries in ${commits.length} commit(s); nothing to write`)
    return 0
  }

  if (options.flags.has("dry-run")) {
    console.log(`would write ${CHANGELOG_FILE} (${version}, ${date}, ${commits.length} commits)`)
    console.log(result.contents)
    return 0
  }
  writeFileSync(join(root, CHANGELOG_FILE), result.contents)
  console.log(`wrote ${CHANGELOG_FILE} (${version}, ${date}, ${commits.length} commits)`)
  return 0
}

function commandCheck(args: string[]): number {
  const options = parseOptions(args, {
    booleans: ["skip-gates", "skip-verify", "with-e2e"],
    values: ["tag", "root"],
  })
  expectNoPositionals(options)
  return runCheck({
    root: rootOf(options),
    skipGates: options.flags.has("skip-gates"),
    skipVerify: options.flags.has("skip-verify"),
    withE2e: options.flags.has("with-e2e"),
    tag: options.values.get("tag"),
  })
}

function usage(): string {
  return [
    "usage: release <command> [options]",
    "",
    "  version                        print the workspace version",
    "  bump --major|--minor|--patch   bump the version everywhere",
    "       --set X.Y.Z               set an explicit version",
    "       --dry-run                 print every file, write none",
    "       --allow-dirty             skip the clean-tree refusal",
    "  changelog [--version X.Y.Z] [--from REF] [--date YYYY-MM-DD] [--dry-run]",
    "  check [--skip-gates] [--skip-verify] [--with-e2e] [--tag vX.Y.Z]",
    "",
    `  ${VERSION_FILE} is the single source; every released package mirrors it.`,
  ].join("\n")
}

function main(argv: string[]): number {
  const [command, ...args] = argv
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(usage())
    return command === undefined ? 2 : 0
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage())
    return 0
  }
  if (command === "version") return commandVersion(args)
  if (command === "bump") return commandBump(args)
  if (command === "changelog") return commandChangelog(args)
  if (command === "check") return commandCheck(args)
  throw new UsageError(`unknown command: ${command}`)
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.exitCode = describeFailure(error)
}
