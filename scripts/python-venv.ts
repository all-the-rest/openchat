import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Shared plumbing for `pnpm run setup:python` and `pnpm run python:check`.
 * Node built-ins only: the setup path must not add a JavaScript dependency to
 * install a Python one.
 */

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
export const VENV_DIR = join(REPO_ROOT, ".venv")
export const LOCK_FILE = join(REPO_ROOT, "packages", "python-env", "requirements.lock")
/**
 * The native half of the toolchain. The image gets these from apk; a
 * workstation installs the same versions from PyPI (`--no-deps`), so both
 * environments run the same distributions.
 */
export const DEV_LOCK_FILE = join(REPO_ROOT, "packages", "python-env", "requirements-dev.lock")
/**
 * Test-only pins for the Python unit tests of the tool scripts. Never part of
 * the image, which proves the same behaviour through `deploy/python-smoke.py`.
 */
export const TEST_LOCK_FILE = join(REPO_ROOT, "packages", "python-env", "requirements-test.lock")

/** The image is 3.14; anything older than 3.12 is outside the support window. */
export const MIN_MINOR = 12
/** The version the lock and the production image are built and measured on. */
export const TARGET_MINOR = 14

export const IMPORTS = [
  "docx",
  "openpyxl",
  "reportlab",
  "PIL",
  "markitdown",
  "magika",
  "onnxruntime",
] as const
export const IMPORT_CHECK = IMPORTS.join(", ")

export interface PythonVersion {
  major: number
  minor: number
  patch: number
  /** `3.14.10`, exactly as the interpreter printed it. */
  raw: string
}

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

export function fail(message: string): never {
  console.error(`python: ${message}`)
  process.exit(1)
}

/** `python3` on Unix, `python` on Windows; `PYTHON` overrides both. */
export function pythonCommand(): string {
  return process.env.PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3")
}

export function venvPython(): string {
  return process.platform === "win32"
    ? join(VENV_DIR, "Scripts", "python.exe")
    : join(VENV_DIR, "bin", "python")
}

export function run(command: string, args: string[], inherit = false): CommandResult {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  })
  if (result.error) {
    return { status: null, stdout: "", stderr: result.error.message }
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

/** The interpreter prints its own tuple, so no `Python 3.x.y` parsing is needed. */
export function versionOf(command: string): PythonVersion | null {
  const result = run(command, [
    "-c",
    "import sys; print('%d.%d.%d' % sys.version_info[:3])",
  ])
  if (result.status !== 0) return null
  const match = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(result.stdout)
  if (!match) return null
  const [, major, minor, patch] = match
  if (major === undefined || minor === undefined || patch === undefined) return null
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    raw: `${major}.${minor}.${patch}`,
  }
}

export function supportsImports(command: string): boolean {
  return run(command, ["-c", `import ${IMPORT_CHECK}`]).status === 0
}

export function requireSupported(version: PythonVersion, source: string): void {
  if (version.major !== 3 || version.minor < MIN_MINOR) {
    fail(
      `${source} is ${version.raw}; 3.${MIN_MINOR}+ is required ` +
        "(the production image uses 3.14)",
    )
  }
}

export function warnIfNotTarget(version: PythonVersion): void {
  if (version.major === 3 && version.minor === TARGET_MINOR) return
  console.warn(
    `python: ${version.raw} is supported, but the pinned wheels were measured on ` +
      `3.${TARGET_MINOR}; a dependency without a wheel for this interpreter builds from source`,
  )
}

export function ensureLockFile(): void {
  for (const file of [LOCK_FILE, DEV_LOCK_FILE, TEST_LOCK_FILE]) {
    if (!existsSync(file)) {
      fail(`missing ${file}; the lock is part of the repository`)
    }
  }
}
