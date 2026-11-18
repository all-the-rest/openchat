import { loadToolEnv } from "@openchat/artifact-tool/env"
import type { ToolEnv } from "@openchat/artifact-tool/env"

/**
 * The tool's own configuration. The BFF URL and the bearer token are the same
 * two values the app tool reads; `OPENCHAT_PYTHON` is the interpreter, which
 * points at the repository venv in development and at `python3` in the image.
 */

export const DEFAULT_PYTHON = "python3"

export interface DocumentsEnv extends ToolEnv {
  /** Interpreter command or absolute path; never model input. */
  python: string
}

export interface LoadDocumentsEnvOptions {
  /** Injected for tests; defaults to `process.env`. */
  source?: Record<string, string | undefined>
}

function readPython(source: Record<string, string | undefined>): string {
  const raw = source.OPENCHAT_PYTHON
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PYTHON
  const value = raw.trim()
  if (value.includes("\u0000") || value.includes("\n") || value.includes("\r")) {
    throw new Error("OPENCHAT_PYTHON must be one command or path")
  }
  return value
}

export function loadDocumentsEnv(options: LoadDocumentsEnvOptions = {}): DocumentsEnv {
  const source = options.source ?? process.env
  const base = loadToolEnv({ source })
  return { ...base, python: readPython(source) }
}
