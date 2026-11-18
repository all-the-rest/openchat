#!/usr/bin/env node
/**
 * `pnpm run setup:python` — one virtualenv, two locks (the pip half and the
 * native half), no extra JavaScript dependency. The production image installs
 * the same pins from a wheelhouse plus apk; this command is the development
 * path and may reach PyPI.
 */
import { existsSync } from "node:fs"
import {
  DEV_LOCK_FILE,
  IMPORT_CHECK,
  LOCK_FILE,
  TEST_LOCK_FILE,
  VENV_DIR,
  ensureLockFile,
  fail,
  pythonCommand,
  requireSupported,
  run,
  supportsImports,
  venvPython,
  versionOf,
  warnIfNotTarget,
} from "./python-venv.ts"

function main(): void {
  ensureLockFile()
  const command = pythonCommand()
  const host = versionOf(command)
  if (!host) {
    fail(
      `no working interpreter at "${command}"; install Python 3.12+ ` +
        "or set PYTHON to its path",
    )
  }
  requireSupported(host, `"${command}"`)
  warnIfNotTarget(host)

  if (existsSync(VENV_DIR)) {
    const existing = versionOf(venvPython())
    if (!existing) {
      fail(`.venv has no working interpreter; delete ${VENV_DIR} and rerun`)
    }
    if (existing.major !== host.major || existing.minor !== host.minor) {
      fail(
        `.venv uses ${existing.major}.${existing.minor} but "${command}" is ` +
          `${host.major}.${host.minor}; delete ${VENV_DIR} and rerun`,
      )
    }
  } else {
    const created = run(command, ["-m", "venv", VENV_DIR], true)
    if (created.status !== 0) fail(`could not create ${VENV_DIR}`)
  }

  const python = venvPython()
  const installed = run(
    python,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-deps",
      "-r",
      LOCK_FILE,
      "-r",
      DEV_LOCK_FILE,
      "-r",
      TEST_LOCK_FILE,
    ],
    true,
  )
  if (installed.status !== 0) fail("pip could not install the requirement locks")

  if (!supportsImports(python)) {
    fail(`the new environment cannot import ${IMPORT_CHECK}; rerun in a clean shell`)
  }
  const version = versionOf(python)
  console.log(`python: .venv ready (${version?.raw ?? "unknown"}; ${IMPORT_CHECK})`)
}

main()
