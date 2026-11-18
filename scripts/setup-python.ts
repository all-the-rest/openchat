/**
 * Python environment for the typed document tools (issue #24).
 *
 * `pnpm run setup:python` creates `.venv` from a Python >= 3.12, installs the
 * pinned `packages/python-env/requirements.lock` and verifies the imports.
 * `pnpm run python:check` only verifies an existing venv and skips cleanly when
 * there is none, so `gates:fast` needs no network and no interpreter.
 *
 * The venv is the development side of the same set the production image
 * installs offline from its wheelhouse. No third-party dependency: everything
 * here is `node:child_process` and `node:fs`.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const VENV = join(ROOT, ".venv")
const VENV_PYTHON = join(VENV, "bin", "python")
const LOCK = join(ROOT, "packages", "python-env", "requirements.lock")
const MIN_MAJOR = 3
const MIN_MINOR = 12
const IMPORTS = "import docx, openpyxl, pypdf, reportlab, PIL"

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

type RunMode = "quiet" | "inherit"

function run(command: string, args: string[], mode: RunMode = "quiet"): RunResult {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: mode === "inherit" ? "inherit" : "pipe",
    env: process.env,
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  }
}

function fail(message: string): never {
  process.stderr.write(`python: ${message}\n`)
  process.exit(1)
}

/**
 * `major.minor.patch` of an interpreter, or `null` when it cannot run. The
 * probe is one `-c` call with no repository code involved.
 */
function versionOf(python: string): number[] | null {
  const result = run(python, [
    "-c",
    'import sys; print("%d.%d.%d" % sys.version_info[:3])',
  ])
  if (result.status !== 0) return null
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(result.stdout.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function label(version: number[]): string {
  return version.join(".")
}

/** True when the interpreter meets the minimum; the reason names both parts. */
function supported(version: number[]): boolean {
  const [major, minor] = version
  if (major === undefined || minor === undefined) return false
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)
}

/** The pinned set must import; this is the acceptance sentence of the issue. */
function importsWork(python: string): boolean {
  const result = run(python, ["-c", IMPORTS])
  return result.status === 0
}

function check(): void {
  if (!existsSync(VENV_PYTHON)) {
    process.stdout.write("python: no .venv; run `pnpm run setup:python` (skipped)\n")
    return
  }
  const version = versionOf(VENV_PYTHON)
  if (!version) {
    fail(".venv/bin/python does not run; remove .venv and rerun `pnpm run setup:python`")
  }
  if (!supported(version)) {
    fail(
      `.venv is Python ${label(version)}; ${MIN_MAJOR}.${MIN_MINOR} or newer is required. ` +
        "Remove .venv and rerun `pnpm run setup:python`",
    )
  }
  if (!importsWork(VENV_PYTHON)) {
    fail(
      ".venv exists but the pinned imports fail; rerun `pnpm run setup:python` " +
        "(it installs packages/python-env/requirements.lock)",
    )
  }
  process.stdout.write(`python: .venv OK (Python ${label(version)})\n`)
}

function setup(): void {
  if (!existsSync(LOCK)) fail("packages/python-env/requirements.lock is missing")

  const base = (process.env.OPENCHAT_PYTHON ?? "python3").trim() || "python3"
  const baseVersion = versionOf(base)
  if (!baseVersion) {
    fail(`${base} does not run; install Python ${MIN_MAJOR}.${MIN_MINOR}+ (or set OPENCHAT_PYTHON)`)
  }
  if (!supported(baseVersion)) {
    fail(
      `${base} is Python ${label(baseVersion)}; the pinned set needs ${MIN_MAJOR}.${MIN_MINOR}+ ` +
        "(the production image ships the Alpine 3.14 interpreter)",
    )
  }

  if (existsSync(VENV_PYTHON)) {
    const venvVersion = versionOf(VENV_PYTHON)
    if (!venvVersion) {
      fail(".venv/bin/python does not run; remove .venv and rerun")
    }
    if (!supported(venvVersion)) {
      fail(
        `.venv is Python ${label(venvVersion)}; ${MIN_MAJOR}.${MIN_MINOR}+ is required. ` +
          "Remove .venv and rerun `pnpm run setup:python`",
      )
    }
    if (venvVersion[0] !== baseVersion[0] || venvVersion[1] !== baseVersion[1]) {
      fail(
        `.venv is Python ${label(venvVersion)} but ${base} is Python ${label(baseVersion)}; ` +
          "a venv cannot change its interpreter. Remove .venv and rerun `pnpm run setup:python`",
      )
    }
  } else {
    process.stdout.write(`python: creating .venv from ${base} (Python ${label(baseVersion)})\n`)
    const created = run(base, ["-m", "venv", VENV], "inherit")
    if (created.status !== 0) {
      fail("could not create .venv; is the venv module installed?")
    }
  }

  process.stdout.write("python: installing packages/python-env/requirements.lock\n")
  const installed = run(
    VENV_PYTHON,
    ["-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check", "-r", LOCK],
    "inherit",
  )
  if (installed.status !== 0) {
    fail("pip install failed (it needs network access); rerun `pnpm run setup:python`")
  }

  if (!importsWork(VENV_PYTHON)) {
    fail("the pinned imports fail after install; rerun `pnpm run setup:python`")
  }
  const version = versionOf(VENV_PYTHON)
  process.stdout.write(
    `python: .venv ready (Python ${version ? label(version) : "unknown"}); ` +
      `OPENCHAT_PYTHON=${VENV_PYTHON}\n`,
  )
}

if (process.argv.includes("--check")) check()
else setup()
