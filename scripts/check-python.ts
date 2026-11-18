#!/usr/bin/env node
/**
 * `pnpm run python:check` — the offline gate. It never installs anything and
 * never reaches the network: a clone without `.venv` skips, while a present
 * environment must be usable or the gate fails.
 */
import { existsSync } from "node:fs"
import {
  IMPORT_CHECK,
  VENV_DIR,
  requireSupported,
  supportsImports,
  venvPython,
  versionOf,
} from "./python-venv.ts"

function main(): void {
  if (!existsSync(VENV_DIR)) {
    console.log("python: no .venv; skipped (run pnpm run setup:python)")
    return
  }
  const version = versionOf(venvPython())
  if (!version) {
    console.error("python: .venv has no working interpreter; run pnpm run setup:python")
    process.exit(1)
  }
  requireSupported(version, ".venv")
  if (!supportsImports(venvPython())) {
    console.error(
      `python: .venv cannot import ${IMPORT_CHECK}; run pnpm run setup:python`,
    )
    process.exit(1)
  }
  console.log(`python: ok (${version.raw}; ${IMPORT_CHECK})`)
}

main()
