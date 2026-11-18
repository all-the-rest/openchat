import { constants } from "node:fs"
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { errorText, isErrorCode } from "./errors"
import type { ErrorCode } from "./errors"
import { runProcess } from "./process"
import type { ProcessRunner } from "./process"

/**
 * The subprocess guard: one fixed script from this package, a JSON request on
 * stdin, a throwaway temp dir as cwd, a deadline, a memory cap applied inside
 * the script and a result protocol on stdout. The dir is removed on success and
 * on every failure path. Nothing here accepts a path from the model.
 */

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MEMORY_MB = 256
/** Raw output cap; base64 in one artifact stays below `ARTIFACT_MAX_BYTES`. */
export const MAX_OUTPUT_BYTES = 700_000
export const MAX_STDOUT_BYTES = 2_000_000

const SCRIPT_NAMES = {
  docx_fill: "output.docx",
  xlsx_write: "output.xlsx",
  pdf_from_markdown: "output.pdf",
} as const

export type PythonScript = keyof typeof SCRIPT_NAMES | "read_document"

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

export interface PythonRunRequest {
  script: PythonScript
  /** Tool metadata; the runner adds `input`/`output` itself. */
  payload: Record<string, unknown>
  /** At most one input file, under a fixed name chosen by the tool. */
  files?: Record<string, Uint8Array>
  /** Expected output file name; defaults to the script's fixed name. */
  output?: string
}

export interface PythonRunDeps {
  /** Interpreter command or absolute path (`OPENCHAT_PYTHON`). */
  python: string
  /** Injected for tests; defaults to `../python/` next to this module. */
  scriptDir?: URL
  /** Injected for tests; defaults to the real spawn. */
  runProcess?: ProcessRunner
  /** Injected for tests; defaults to the OS temp dir. */
  tempRoot?: string
  timeoutMs?: number
  memoryMb?: number
}

export interface PythonRunValue {
  file?: { name: string; bytes: Uint8Array }
  text?: string
}

export type PythonRunResult =
  | { ok: true; value: PythonRunValue }
  | { ok: false; code: ErrorCode; message: string }

export interface TempDir {
  path: string
  remove: () => Promise<void>
}

/** One private dir per run; `remove` is idempotent and never throws. */
export async function createTempDir(root?: string): Promise<TempDir> {
  const base = root ?? tmpdir()
  const path = await mkdtemp(join(base, "openchat-python-"))
  return {
    path,
    remove: async () => {
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failure(code: ErrorCode): PythonRunResult {
  return { ok: false, code, message: errorText(code) }
}

function scriptPath(deps: PythonRunDeps, script: PythonScript): string {
  const dir = deps.scriptDir ?? new URL("../python/", import.meta.url)
  return fileURLToPath(new URL(`${script}.py`, dir))
}

function safeName(value: unknown): value is string {
  return typeof value === "string" && SAFE_NAME.test(value) && !value.includes("..")
}

/** The last non-empty stdout line, parsed as the one protocol object. */
function parseProtocol(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0)
  const last = lines[lines.length - 1]
  if (last === undefined) return null
  try {
    const parsed: unknown = JSON.parse(last)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Reads the declared output without following a link and without trusting its
 * size: the script can only write inside the temp dir, and a non-regular file
 * or an oversized one is a protocol violation, not a result.
 */
async function readOutput(
  dir: string,
  name: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const path = join(dir, name)
  if (basename(path) !== name) return { ok: false }
  let stat
  try {
    stat = await lstat(path)
  } catch {
    return { ok: false }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OUTPUT_BYTES) {
    return { ok: false }
  }
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const bytes = await handle.readFile()
      if (bytes.byteLength > MAX_OUTPUT_BYTES) return { ok: false }
      return { ok: true, bytes: new Uint8Array(bytes) }
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false }
  }
}

export async function runPython(
  request: PythonRunRequest,
  deps: PythonRunDeps,
): Promise<PythonRunResult> {
  const path = scriptPath(deps, request.script)
  if (!existsSync(path)) return failure("invalid_output")

  const defaultOutput =
    request.script === "read_document" ? undefined : SCRIPT_NAMES[request.script]
  const output = request.output ?? defaultOutput
  if (output !== undefined && !safeName(output)) return failure("invalid_output")

  const files = Object.entries(request.files ?? {})
  if (files.length > 1) return failure("invalid_output")
  const input = files[0]
  if (input && !safeName(input[0])) return failure("invalid_output")

  const temp = await createTempDir(deps.tempRoot)
  try {
    if (input) await writeFile(join(temp.path, input[0]), input[1])

    const payload: Record<string, unknown> = { ...request.payload }
    if (output !== undefined) payload.output = output
    if (input) payload.input = input[0]

    const runner = deps.runProcess ?? runProcess
    const outcome = await runner({
      command: deps.python,
      args: ["-I", "-B", path, String(deps.memoryMb ?? DEFAULT_MEMORY_MB)],
      cwd: temp.path,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: temp.path,
        TMPDIR: temp.path,
        PYTHONHASHSEED: "0",
        PYTHONDONTWRITEBYTECODE: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      input: JSON.stringify(payload),
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
    })

    if (outcome.timedOut) return failure("timeout")
    if (outcome.spawnFailed) return failure("python_missing")
    if (outcome.stdoutOverflow) return failure("invalid_output")
    if (outcome.status !== 0) {
      // Best effort only: the traceback text is classified, never returned.
      return failure(outcome.stderr.includes("MemoryError") ? "memory" : "crashed")
    }

    const protocol = parseProtocol(outcome.stdout)
    if (!protocol) return failure("invalid_output")
    if (protocol.ok !== true) {
      const code = isErrorCode(protocol.code) ? protocol.code : "crashed"
      return failure(code)
    }

    if (request.script === "read_document") {
      if (typeof protocol.text !== "string") return failure("invalid_output")
      return { ok: true, value: { text: protocol.text } }
    }

    const declared = protocol.file ?? output
    if (!safeName(declared)) return failure("invalid_output")
    const read = await readOutput(temp.path, declared)
    if (!read.ok) return failure("invalid_output")
    return { ok: true, value: { file: { name: declared, bytes: read.bytes } } }
  } catch {
    return failure("crashed")
  } finally {
    await temp.remove()
  }
}
