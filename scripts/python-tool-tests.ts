#!/usr/bin/env node
/**
 * `pnpm --filter @openchat/python-tool test` runs the TypeScript suite and
 * then the Python unit tests of the tool scripts. The interpreter is the
 * repository `.venv` (or `PYTHON`); when the document libraries are absent the
 * step skips with one line, because CI has no Python toolchain. The image
 * smoke test (`deploy/python-smoke.py`) covers the same scripts on every build.
 */
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import {
  REPO_ROOT,
  VENV_DIR,
  pythonCommand,
  run,
  venvPython,
  versionOf,
} from "./python-venv.ts"

const TESTS = join(REPO_ROOT, "packages", "python-tool", "python", "tests")
const IMPORTS = "import docx, reportlab, pypdf"

function interpreter(): string {
  return existsSync(VENV_DIR) && existsSync(venvPython()) ? venvPython() : pythonCommand()
}

function main(): void {
  const python = interpreter()
  if (!versionOf(python)) {
    console.log("python-tool: unit tests skipped (no working interpreter)")
    return
  }
  if (run(python, ["-c", IMPORTS]).status !== 0) {
    console.log(
      "python-tool: unit tests skipped (python-docx, reportlab or pypdf missing; " +
        "run pnpm run setup:python)",
    )
    return
  }
  const result = spawnSync(
    python,
    ["-m", "unittest", "discover", "-s", TESTS, "-p", "test_*.py", "-v"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  )
  process.exit(result.status ?? 1)
}

main()
