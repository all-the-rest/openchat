import { MAX_ARCHIVE_DIRECTORY_NAME, MAX_ARCHIVE_PATH_CHARS } from "./limits"

/**
 * Argument validation for `archive_list` and `archive_extract`. Same rules as
 * `validate-documents.ts`: cheap shape first, one short line per rejection,
 * no value and no path echoed back. The path names a chat file, never an
 * arbitrary filesystem location; `archive.ts` resolves it a second time.
 */

export const ARCHIVE_TOOL_NAMES = ["archive_list", "archive_extract"] as const

export type ArchiveToolName = (typeof ARCHIVE_TOOL_NAMES)[number]

export interface ArchiveListInput {
  zipPath: string
}

export interface ArchiveExtractInput {
  zipPath: string
  directory: string
}

export type ArchiveValidatedCall =
  | { name: "archive_list"; value: ArchiveListInput }
  | { name: "archive_extract"; value: ArchiveExtractInput }

export type ArchiveValidationResult =
  | { ok: true; value: ArchiveValidatedCall }
  | { ok: false; error: string }

type Field<T> = { ok: true; value: T } | { ok: false; error: string }

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CHAT_FILE_NAME_MAX = 200

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function readZipPath(value: unknown): Field<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return bad("zipPath: must be a non-empty string")
  }
  const path = value.trim()
  if ([...path].length > MAX_ARCHIVE_PATH_CHARS) {
    return bad(`zipPath: longer than ${MAX_ARCHIVE_PATH_CHARS} characters`)
  }
  if (CONTROL_CHARACTERS.test(path)) return bad("zipPath: contains a control character")
  if (path.startsWith("/") || path.includes("\\") || path.includes("..")) {
    return bad("zipPath: use a path inside WORKSPACE_DIR/chats")
  }
  const parts = path.split("/")
  if (parts.length !== 3 || parts[1] !== "files") {
    return bad("zipPath: expected <sessionID>/files/<name>.zip")
  }
  const name = parts[2] ?? ""
  if (!name.toLowerCase().endsWith(".zip")) return bad("zipPath: must end with .zip")
  if ([...name].length > CHAT_FILE_NAME_MAX) {
    return bad(`zipPath: the file name is longer than ${CHAT_FILE_NAME_MAX} characters`)
  }
  if (name !== name.trim() || name.startsWith(".")) {
    return bad("zipPath: the file name has an unsupported shape")
  }
  return { ok: true, value: path }
}

function readDirectory(value: unknown): Field<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return bad("directory: must be a non-empty string")
  }
  const name = value.trim()
  if (name.length > MAX_ARCHIVE_DIRECTORY_NAME) {
    return bad(`directory: longer than ${MAX_ARCHIVE_DIRECTORY_NAME} characters`)
  }
  if (!DIRECTORY_NAME.test(name)) {
    return bad("directory: use letters, digits, dot, dash or underscore")
  }
  return { ok: true, value: name }
}

export function validateArchiveList(input: Record<string, unknown>): ArchiveValidationResult {
  const zipPath = readZipPath(input.zipPath)
  if (!zipPath.ok) return zipPath
  return { ok: true, value: { name: "archive_list", value: { zipPath: zipPath.value } } }
}

export function validateArchiveExtract(input: Record<string, unknown>): ArchiveValidationResult {
  const zipPath = readZipPath(input.zipPath)
  if (!zipPath.ok) return zipPath
  const directory = readDirectory(input.directory)
  if (!directory.ok) return directory
  return {
    ok: true,
    value: { name: "archive_extract", value: { zipPath: zipPath.value, directory: directory.value } },
  }
}
