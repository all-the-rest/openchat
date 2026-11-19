import { CHAT_FILE_NAME_MAX } from "@openchat/contracts"
import { MAX_ARCHIVE_PATH_CHARS, MAX_ARCHIVE_SUBDIR_CHARS } from "./limits"

/**
 * Argument validation for the two plain-ZIP tools. Kept separate so the shared
 * validator stays under the 400-line gate. Rejections are one short line with
 * a field name; no value, path or stack trace is echoed back to the model.
 */

export interface ArchiveListInput {
  sourcePath: string
}

export interface ArchiveExtractInput {
  sourcePath: string
  subdir: string
}

type DocCall<N extends string, V> = { ok: true; value: { name: N; value: V } }

export type ArchiveValidationResult =
  | DocCall<"archive_list", ArchiveListInput>
  | DocCall<"archive_extract", ArchiveExtractInput>
  | { ok: false; error: string }

type Field<T> = { ok: true; value: T } | { ok: false; error: string }

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const OFFICE = /\.(docx|xlsx|pptx|docm|xlsm|pptm)$/i

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** Mirrors the store's one-segment rule; unicode names are preserved. */
function safeName(value: string, max: number): boolean {
  return (
    value.length > 0 &&
    [...value].length <= max &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith(".") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function readSourcePath(value: unknown): Field<{ sessionID: string; name: string }> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return bad("sourcePath: must be a non-empty string")
  }
  const path = value.trim()
  if ([...path].length > MAX_ARCHIVE_PATH_CHARS) {
    return bad(`sourcePath: longer than ${MAX_ARCHIVE_PATH_CHARS} characters`)
  }
  if (CONTROL_CHARACTERS.test(path) || path.startsWith("/") || path.includes("\\") || path.includes("..")) {
    return bad("sourcePath: use a path inside WORKSPACE_DIR/chats")
  }
  const parts = path.split("/")
  if (parts.length !== 3 || parts[1] !== "files") {
    return bad("sourcePath: expected <sessionID>/files/<name>.zip")
  }
  const [sessionID, , name] = parts as [string, string, string]
  if (!SESSION.test(sessionID)) return bad("sourcePath: invalid session id")
  if (!safeName(name, CHAT_FILE_NAME_MAX)) return bad("sourcePath: invalid file name")
  if (OFFICE.test(name)) {
    return bad("unsupported: Office files stay with read_document")
  }
  if (!name.toLowerCase().endsWith(".zip")) {
    return bad("sourcePath: the archive tools accept plain .zip only")
  }
  return { ok: true, value: { sessionID, name } }
}

function readSubdir(value: unknown): Field<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return bad("subdir: must be a non-empty string")
  }
  const subdir = value.trim()
  if ([...subdir].length > MAX_ARCHIVE_SUBDIR_CHARS) {
    return bad(`subdir: longer than ${MAX_ARCHIVE_SUBDIR_CHARS} characters`)
  }
  if (!safeName(subdir, MAX_ARCHIVE_SUBDIR_CHARS) || subdir.includes("..")) {
    return bad("subdir: use one safe directory name, no separators or '..'")
  }
  return { ok: true, value: subdir }
}

export function validateArchiveList(input: Record<string, unknown>): ArchiveValidationResult {
  const source = readSourcePath(input.sourcePath)
  if (!source.ok) return source
  return {
    ok: true,
    value: { name: "archive_list", value: { sourcePath: input.sourcePath as string } },
  }
}

export function validateArchiveExtract(input: Record<string, unknown>): ArchiveValidationResult {
  const source = readSourcePath(input.sourcePath)
  if (!source.ok) return source
  const subdir = readSubdir(input.subdir)
  if (!subdir.ok) return subdir
  return {
    ok: true,
    value: {
      name: "archive_extract",
      value: { sourcePath: input.sourcePath as string, subdir: subdir.value },
    },
  }
}
