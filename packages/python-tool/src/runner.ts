import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CHILD_OUTPUT_MAX_BYTES,
  MAX_FILE_BYTES,
  TOOL_TIMEOUT_MS,
} from "./limits"
import type { ArchiveToolName } from "./validate-archives"
import type { ToolName } from "./validate"

/**
 * The process boundary. The script path is fixed by tool name, the request is
 * JSON on stdin, there is no shell, the working directory is a fresh temporary
 * directory, and the child gets a minimal environment (never the BFF token).
 * A timeout kills the process group member and the directory is removed on
 * every path, success or failure.
 */

export interface PythonFile {
  filename: string
  mediaType: string
  data: Buffer
}

export type RunResult = { ok: true; value: PythonFile } | { ok: false; error: string }

export interface SpawnOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  /** The exact JSON written to stdin, before any shell could see it. */
  input: string
}

export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  failure?: "spawn" | "output"
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => Promise<ProcessResult>

export interface RunnerOptions {
  /** Defaults to `OPENCHAT_PYTHON` or `python3`. */
  python?: string
  /** Injected by tests; defaults to a real `spawn`. */
  spawn?: SpawnFn
  /** Injected by tests; defaults to the OS temporary directory. */
  tempRoot?: string
  timeoutMs?: number
}

/** The two chat-file tools call the HTTP service, never a Python script. */
export type PythonToolName = Exclude<
  ToolName,
  "documents_fill" | "documents_convert" | ArchiveToolName
>

/** Every tool backed by exactly one fixed script path. */
export type ScriptName = Exclude<ToolName, "documents_fill" | "documents_convert">

export type PythonRunner = (
  tool: PythonToolName,
  input: Record<string, unknown>,
) => Promise<RunResult>

/** One script answer: only the structured body, never stderr. */
export type ScriptRun =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string }

const SCRIPTS: Record<ScriptName, string> = {
  docx_fill: fileURLToPath(new URL("../python/docx_fill.py", import.meta.url)),
  docx_from_text: fileURLToPath(new URL("../python/docx_from_text.py", import.meta.url)),
  xlsx_write: fileURLToPath(new URL("../python/xlsx_write.py", import.meta.url)),
  pdf_from_markdown: fileURLToPath(new URL("../python/pdf_from_markdown.py", import.meta.url)),
  read_document: fileURLToPath(new URL("../python/read_document.py", import.meta.url)),
  archive_list: fileURLToPath(new URL("../python/archive_list.py", import.meta.url)),
  archive_extract: fileURLToPath(new URL("../python/archive_extract.py", import.meta.url)),
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "input: the request could not be read",
  library_missing: "python: the Python environment is incomplete; run pnpm run setup:python",
  parse_failed: "parse: the document could not be read",
  render_failed: "internal: the document could not be generated",
  too_large: "size: the generated document exceeds the artifact limit",
  too_many: "size: the input exceeds the document limits",
  unsupported: "unsupported: this file type cannot be read",
  bad_archive: "archive: the file is not a readable ZIP archive",
  encrypted: "archive: the ZIP has encrypted entries",
  too_many_entries: "archive: the ZIP has more than 500 entries",
  too_deep: "archive: a path nests deeper than 10 directories",
  archive_too_large: "archive: the ZIP expands beyond the 200 MiB uncompressed cap",
  bomb: "archive: refused as a likely zip bomb",
  unsafe_entry: "archive: the ZIP contains an unsafe entry",
  file_too_large: "size: an extracted file exceeds the 20 MiB chat file cap",
  quota_exceeded: "quota: the chat file quota would be exceeded",
  already_exists: "already_exists: the target exists; choose another directory",
  internal: "internal: the archive tool failed",
}

const EXPECTED_EXTENSION: Record<PythonToolName, string> = {
  docx_fill: ".docx",
  docx_from_text: ".docx",
  xlsx_write: ".xlsx",
  pdf_from_markdown: ".pdf",
  read_document: ".md",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

function fixedError(code: string | null): string {
  if (code !== null && Object.hasOwn(ERROR_MESSAGES, code)) {
    return ERROR_MESSAGES[code] ?? "internal: the document tool failed"
  }
  return "internal: the document tool failed"
}

/** Reads only the structured error code; stderr is never consulted. */
function readErrorCode(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (isRecord(parsed) && parsed.ok === false && typeof parsed.code === "string") {
      return parsed.code
    }
  } catch {
    // Fall through to the fixed generic message.
  }
  return null
}

function readSuccess(
  payload: Record<string, unknown>,
  tool: PythonToolName,
): { ok: true; value: PythonFile } | { ok: false; error: string } {
  const { filename, mediaType, data } = payload
  if (typeof filename !== "string" || typeof mediaType !== "string" || typeof data !== "string") {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,159}$/.test(filename)) {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  if (!filename.toLowerCase().endsWith(EXPECTED_EXTENSION[tool])) {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType)) {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  if (!isBase64(data)) {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  const bytes = Buffer.from(data, "base64")
  if (bytes.byteLength === 0) {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: "size: the generated document exceeds the artifact limit" }
  }
  return { ok: true, value: { filename, mediaType, data: bytes } }
}

/** Exit status, timeout and stream failures become one fixed line each. */
function mapScriptResult(result: ProcessResult): ScriptRun {
  if (result.failure === "output") {
    return { ok: false, error: "internal: the document tool produced too much output" }
  }
  if (result.failure === "spawn") {
    return {
      ok: false,
      error: "python: the document tool could not start; run pnpm run setup:python",
    }
  }
  if (result.timedOut) {
    return {
      ok: false,
      error: `timeout: the document tool did not finish in ${TOOL_TIMEOUT_MS / 1000} s`,
    }
  }
  if (result.code !== 0) {
    return { ok: false, error: fixedError(readErrorCode(result.stdout)) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.trim()) as unknown
  } catch {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  if (!isRecord(parsed) || parsed.ok !== true) {
    return { ok: false, error: "internal: the document tool answered an unexpected body" }
  }
  return { ok: true, payload: parsed }
}

/** The real boundary: no shell, a byte cap on both streams, SIGKILL on timeout. */
export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let failure: "spawn" | "output" | undefined
    let settled = false

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, ...(failure ? { failure } : {}) })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, options.timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > CHILD_OUTPUT_MAX_BYTES) {
        failure = "output"
        child.kill("SIGKILL")
        return
      }
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > CHILD_OUTPUT_MAX_BYTES) {
        failure = "output"
        child.kill("SIGKILL")
        return
      }
      stderr += chunk.toString("utf8")
    })
    child.on("error", () => {
      failure = "spawn"
      finish(null)
    })
    child.on("close", (code) => finish(code))
    child.stdin.on("error", () => {
      // The child may exit before it reads; the exit code carries the reason.
    })
    child.stdin.end(options.input)
  })
}

function childEnvironment(cwd: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: cwd,
    TMPDIR: cwd,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONHASHSEED: "0",
    PYTHONUTF8: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  }
}

export function createScriptRunner(
  options: RunnerOptions = {},
): (tool: ScriptName, input: Record<string, unknown>) => Promise<ScriptRun> {
  const python = options.python ?? process.env.OPENCHAT_PYTHON ?? "python3"
  const spawnImpl = options.spawn ?? spawnProcess
  const tempRoot = options.tempRoot ?? tmpdir()
  const timeoutMs = options.timeoutMs ?? TOOL_TIMEOUT_MS

  return async (tool, input) => {
    let cwd: string
    try {
      cwd = await mkdtemp(join(tempRoot, "openchat-python-"))
    } catch {
      return { ok: false, error: "internal: the document tool could not create a workspace" }
    }

    try {
      const result = await spawnImpl(python, [SCRIPTS[tool]], {
        cwd,
        env: childEnvironment(cwd),
        timeoutMs,
        input: JSON.stringify(input),
      })
      return mapScriptResult(result)
    } catch {
      return { ok: false, error: "internal: the document tool failed" }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

export function createRunner(options: RunnerOptions = {}): PythonRunner {
  const run = createScriptRunner(options)
  return async (tool, input) => {
    const result = await run(tool, input)
    if (!result.ok) return result
    return readSuccess(result.payload, tool)
  }
}
