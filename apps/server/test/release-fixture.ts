/**
 * Shared fixture for the release-machinery tests: a throwaway git repository
 * with the same version layout as the real workspace, plus helpers to run the
 * CLI and to put a fake `pnpm`/`ratchet` on PATH.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const RELEASE = join(import.meta.dirname, "..", "..", "..", "scripts", "release.ts")

export const PACKAGES = [
  "apps/server",
  "apps/code-host",
  "apps/artifact-host",
  "packages/code-ticket",
  "packages/contracts",
  "packages/opencode",
]

const created: string[] = []

export function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "openchat-release-"))
  created.push(root)
  writeFiles(root, files)
  return root
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, contents)
  }
}

export function cleanup(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function git(root: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  )
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
  return result.stdout
}

export function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.name", "Release Test")
  git(root, "config", "user.email", "release@example.invalid")
}

export function commit(root: string, message: string, files: Record<string, string> = {}): void {
  writeFiles(root, files)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", message)
}

function manifest(name: string, version?: string): string {
  const versionLine = version === undefined ? "" : `  "version": "${version}",\n`
  return `{\n  "name": "${name}",\n${versionLine}  "private": true\n}\n`
}

const NAMES: Record<string, string> = {
  "apps/server": "@openchat/server",
  "apps/code-host": "@openchat/code-host",
  "apps/artifact-host": "@openchat/artifact-host",
  "packages/code-ticket": "@openchat/code-ticket",
  "packages/contracts": "@openchat/contracts",
  "packages/opencode": "@openchat/opencode",
}

export const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [1.2.3] - 2026-01-01

### Added

- the previous release
`

/** A workspace that is internally consistent at `version`. */
export function workspace(version = "1.2.3"): Record<string, string> {
  const files: Record<string, string> = {
    VERSION: `${version}\n`,
    "apps/server/src/app.ts": `export const SERVER_VERSION = "${version}"\n`,
    "apps/web/package.json": manifest("@openchat/web"),
    "CHANGELOG.md": CHANGELOG.replace("1.2.3", version),
  }
  for (const path of PACKAGES) {
    files[`${path}/package.json`] = manifest(NAMES[path] ?? path, version)
  }
  const importers = Object.keys(NAMES)
    .map((path, index) => {
      const versionLine = index === 0 ? `    version: ${version}\n` : ""
      return `  ${path}:\n${versionLine}    dependencies: {}\n`
    })
    .join("")
  files["pnpm-lock.yaml"] = `lockfileVersion: '9.0'\n\nimporters:\n\n${importers}`
  return files
}

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export function runRelease(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): RunResult {
  const result = spawnSync(process.execPath, [RELEASE, ...args, ...(args.includes("--root") ? [] : ["--root", root])], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

export function readJson(path: string): { version?: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { version?: string }
}

/** A fake executable that appends its arguments to `$LOG` and exits `$CODE`. */
export function fakeBin(root: string, name: string): string {
  const bin = join(root, "fake-bin")
  mkdirSync(bin, { recursive: true })
  const path = join(bin, name)
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LOG"\nexit "\${CODE:-0}"\n`,
  )
  chmodSync(path, 0o755)
  return bin
}

export function logLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0)
  } catch {
    return []
  }
}
