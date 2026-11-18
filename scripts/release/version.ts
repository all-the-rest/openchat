/**
 * The version itself: parsing, bumping and the files that mirror `VERSION`.
 *
 * Every write is planned first (`BumpPlan`), so `--dry-run` can print the plan
 * and a test can assert that a dry run changes nothing. The only files touched
 * are the single source, the workspace manifests, the `/healthz` constant and
 * the lockfile importer records when pnpm actually stores a workspace version.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  LOCKFILE_FILE,
  SERVER_VERSION_FILE,
  UNVERSIONED_PACKAGES,
  VERSION_FILE,
} from "./config.ts"
import { ReleaseError } from "./git.ts"

export type BumpKind = "major" | "minor" | "patch"

export interface Semver {
  major: number
  minor: number
  patch: number
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseSemver(value: string): Semver | null {
  const match = SEMVER_RE.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function formatSemver(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

export function bumpVersion(current: string, kind: BumpKind): string {
  const parsed = parseSemver(current)
  if (!parsed) throw new ReleaseError(`${VERSION_FILE} is not a version: ${current}`)
  if (kind === "major") return formatSemver({ major: parsed.major + 1, minor: 0, patch: 0 })
  if (kind === "minor") {
    return formatSemver({ major: parsed.major, minor: parsed.minor + 1, patch: 0 })
  }
  return formatSemver({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 })
}

export interface PackageVersion {
  /** Repository-relative directory, e.g. `apps/server`. */
  path: string
  name: string
  version: string | null
}

export interface VersionState {
  version: string
  packages: PackageVersion[]
  /** The literal in `apps/server/src/app.ts`, or null when absent. */
  serverVersion: string | null
  /** Versions recorded per lockfile importer, when the lockfile carries them. */
  lockfileVersions: Map<string, string>
}

interface Manifest {
  name?: unknown
  version?: unknown
}

export function readVersionFile(root: string): string {
  const path = join(root, VERSION_FILE)
  if (!existsSync(path)) {
    throw new ReleaseError(`${VERSION_FILE} is missing; it is the single version source`)
  }
  return readFileSync(path, "utf8").trim()
}

/** Workspace packages that ship in an image, sorted by path. */
export function discoverPackages(root: string): string[] {
  const found: string[] = []
  for (const top of ["apps", "packages"]) {
    const dir = join(root, top)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = `${top}/${entry.name}`
      if (UNVERSIONED_PACKAGES.includes(path)) continue
      if (existsSync(join(root, path, "package.json"))) found.push(path)
    }
  }
  return found.sort()
}

function readManifest(root: string, path: string): Manifest {
  const file = join(root, path, "package.json")
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest
  } catch (error) {
    throw new ReleaseError(`cannot parse ${path}/package.json: ${(error as Error).message}`)
  }
}

export function readLockfileVersions(root: string): Map<string, string> {
  const versions = new Map<string, string>()
  const path = join(root, LOCKFILE_FILE)
  if (!existsSync(path)) return versions
  let underImporters = false
  let importer: string | null = null
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "importers:") {
      underImporters = true
      continue
    }
    if (!underImporters) continue
    const importerMatch = /^ {2}(\S.*?):(?: \{\})?$/.exec(line)
    if (importerMatch) {
      importer = importerMatch[1] ?? null
      continue
    }
    if (importer !== null) {
      const versionMatch = /^ {4}version: (.+)$/.exec(line)
      if (versionMatch) versions.set(importer, (versionMatch[1] ?? "").trim())
      else if (/^\S/.test(line)) underImporters = false
    } else if (/^\S/.test(line)) {
      underImporters = false
    }
  }
  return versions
}

export function readState(root: string): VersionState {
  const version = readVersionFile(root)
  const packages = discoverPackages(root).map((path) => {
    const manifest = readManifest(root, path)
    return {
      path,
      name: typeof manifest.name === "string" ? manifest.name : path,
      version: typeof manifest.version === "string" ? manifest.version : null,
    }
  })
  const serverFile = join(root, SERVER_VERSION_FILE)
  const serverText = existsSync(serverFile) ? readFileSync(serverFile, "utf8") : ""
  const serverVersion = /export const SERVER_VERSION = "([^"]*)"/.exec(serverText)?.[1] ?? null
  return { version, packages, serverVersion, lockfileVersions: readLockfileVersions(root) }
}

export function checkAgreement(state: VersionState): string[] {
  const problems: string[] = []
  if (!parseSemver(state.version)) {
    problems.push(`${VERSION_FILE} is not a version: ${state.version}`)
  }
  for (const pkg of state.packages) {
    if (pkg.version === null) {
      problems.push(`${pkg.path}/package.json has no version (${VERSION_FILE} says ${state.version})`)
    } else if (pkg.version !== state.version) {
      problems.push(
        `${pkg.path}/package.json has version ${pkg.version}, ${VERSION_FILE} says ${state.version}`,
      )
    }
  }
  if (state.serverVersion === null) {
    problems.push(`${SERVER_VERSION_FILE} has no SERVER_VERSION literal`)
  } else if (state.serverVersion !== state.version) {
    problems.push(
      `${SERVER_VERSION_FILE} has SERVER_VERSION ${state.serverVersion}, ${VERSION_FILE} says ${state.version}`,
    )
  }
  for (const pkg of state.packages) {
    const recorded = state.lockfileVersions.get(pkg.path)
    if (recorded !== undefined && recorded !== state.version) {
      problems.push(
        `${LOCKFILE_FILE} records ${pkg.path} at ${recorded}, ${VERSION_FILE} says ${state.version}`,
      )
    }
  }
  return problems
}

export interface FileChange {
  path: string
  before: string
  after: string
  contents: string
}

/** Replace the first top-level `"version"` value, or insert one after `name`. */
export function renderManifestVersion(text: string, version: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(eol)
  const versionLine = /^ {2}"version": "([^"]*)",?$/
  const existing = lines.findIndex((line) => versionLine.test(line))
  if (existing !== -1) {
    lines[existing] = `  "version": "${version}",`
    return lines.join(eol)
  }
  const nameLine = lines.findIndex((line) => /^ {2}"name": "[^"]*",$/.test(line))
  if (nameLine === -1) {
    throw new ReleaseError("package.json has neither a version nor a name field")
  }
  lines.splice(nameLine + 1, 0, `  "version": "${version}",`)
  return lines.join(eol)
}

export function renderServerVersion(text: string, version: string): string {
  if (!/export const SERVER_VERSION = "[^"]*"/.test(text)) {
    throw new ReleaseError(`${SERVER_VERSION_FILE} has no SERVER_VERSION literal`)
  }
  return text.replace(
    /export const SERVER_VERSION = "[^"]*"/,
    `export const SERVER_VERSION = "${version}"`,
  )
}

/** Rewrite importer-level versions; pnpm's current lockfile carries none. */
export function renderLockfileVersions(
  text: string,
  versions: Map<string, string>,
): { contents: string; touched: string[] } {
  const lines = text.split("\n")
  const touched: string[] = []
  let underImporters = false
  let importer: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (line === "importers:") {
      underImporters = true
      continue
    }
    if (!underImporters) continue
    const importerMatch = /^ {2}(\S.*?):(?: \{\})?$/.exec(line)
    if (importerMatch) {
      importer = importerMatch[1] ?? null
      continue
    }
    if (importer === null) {
      if (/^\S/.test(line)) underImporters = false
      continue
    }
    const next = versions.get(importer)
    if (next !== undefined && /^ {4}version: /.test(line)) {
      lines[index] = `    version: ${next}`
      if (!touched.includes(importer)) touched.push(importer)
    } else if (/^\S/.test(line)) {
      underImporters = false
      importer = null
    }
  }
  return { contents: lines.join("\n"), touched }
}

function readIfPresent(root: string, path: string): string | null {
  const file = join(root, path)
  return existsSync(file) ? readFileSync(file, "utf8") : null
}

/** Every file the bump would touch, with its rendered contents. */
export function planBump(root: string, state: VersionState, next: string): FileChange[] {
  if (!parseSemver(next)) throw new ReleaseError(`not a version: ${next}`)
  const changes: FileChange[] = []
  changes.push({
    path: VERSION_FILE,
    before: state.version,
    after: next,
    contents: `${next}\n`,
  })

  for (const pkg of state.packages) {
    const path = `${pkg.path}/package.json`
    const text = readIfPresent(root, path)
    if (text === null) throw new ReleaseError(`${path} is missing`)
    changes.push({
      path,
      before: pkg.version ?? "absent",
      after: next,
      contents: renderManifestVersion(text, next),
    })
  }

  const serverText = readIfPresent(root, SERVER_VERSION_FILE)
  if (serverText === null) throw new ReleaseError(`${SERVER_VERSION_FILE} is missing`)
  changes.push({
    path: SERVER_VERSION_FILE,
    before: state.serverVersion ?? "absent",
    after: next,
    contents: renderServerVersion(serverText, next),
  })

  const lockText = readIfPresent(root, LOCKFILE_FILE)
  if (lockText !== null) {
    const importerVersions = new Map<string, string>()
    for (const pkg of state.packages) {
      if (state.lockfileVersions.has(pkg.path)) importerVersions.set(pkg.path, next)
    }
    const rendered = renderLockfileVersions(lockText, importerVersions)
    if (rendered.touched.length > 0) {
      changes.push({
        path: LOCKFILE_FILE,
        before: rendered.touched.map((path) => `${path}@${state.lockfileVersions.get(path)}`).join(", "),
        after: rendered.touched.map((path) => `${path}@${next}`).join(", "),
        contents: rendered.contents,
      })
    }
  }

  return changes
}

export function applyChanges(root: string, changes: FileChange[], dryRun: boolean): void {
  for (const change of changes) {
    if (dryRun) {
      console.log(`would write ${change.path}: ${change.before} -> ${change.after}`)
    } else {
      writeFileSync(join(root, change.path), change.contents)
      console.log(`wrote ${change.path}: ${change.before} -> ${change.after}`)
    }
  }
}
