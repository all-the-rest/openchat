import { lstat, readdir, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { CHAT_FILE_MAX_BYTES, CHAT_QUOTA_PER_CHAT_BYTES } from "@openchat/contracts"
import type { ArchiveOutcome, ArchiveRunner } from "./archive-types"
import { chatFilesDirectory } from "./template"

/**
 * Filesystem half of the archive tools. The model names a chat file path and a
 * subdirectory, never an absolute target: the path is parsed into three
 * segments, resolved below the real `chats/<session>/files` directory, and the
 * source is opened only after an `lstat`/`realpath` check. Python then writes
 * entry by entry with `O_CREAT | O_EXCL | O_NOFOLLOW` and rolls back on any
 * refusal. The chat's used bytes are summed here, because the BFF's index
 * accounting does not know about extracted subdirectories.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_NAME = 200
const MAX_USED_ENTRIES = 20_000
const MAX_USED_DEPTH = 12

export interface ArchiveSource {
  sessionID: string
  name: string
  /** Resolved absolute path of the `.zip`, safe for the script to open. */
  path: string
  /** Resolved absolute `files/` directory that owns the archive. */
  filesReal: string
}

export type ArchiveSourceResult =
  | ({ ok: true } & ArchiveSource)
  | { ok: false; error: string }

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

/** The three path segments the caller may name; mirrors the upload shape. */
export function archiveParts(zipPath: string): { sessionID: string; name: string } | null {
  if (isAbsolute(zipPath) || zipPath.includes("\\") || zipPath.includes("..")) return null
  const parts = zipPath.split("/")
  if (parts.length !== 3 || parts[1] !== "files") return null
  const [sessionID, , name] = parts as [string, string, string]
  if (sessionID.length === 0 || name.length === 0) return null
  if ([...name].length > MAX_NAME || CONTROL_CHARACTERS.test(name)) return null
  if (name !== name.trim() || name.startsWith(".")) return null
  if (!name.toLowerCase().endsWith(".zip")) return null
  return { sessionID, name }
}

export async function resolveArchiveSource(
  workspaceDir: string,
  zipPath: string,
): Promise<ArchiveSourceResult> {
  const parts = archiveParts(zipPath)
  if (!parts) {
    return { ok: false, error: "zipPath: use <sessionID>/files/<name>.zip inside WORKSPACE_DIR/chats" }
  }
  try {
    const filesReal = await chatFilesDirectory(workspaceDir, parts.sessionID)
    if (!filesReal) {
      return { ok: false, error: "zipPath: the chat directory is not a safe directory" }
    }
    const path = join(filesReal, parts.name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return { ok: false, error: "zipPath: not a regular file" }
    }
    if (stat.size === 0) return { ok: false, error: "zipPath: the file is empty" }
    if (stat.size > CHAT_FILE_MAX_BYTES) {
      return {
        ok: false,
        error: `zipPath: larger than the ${CHAT_FILE_MAX_BYTES / (1024 * 1024)} MiB chat file cap`,
      }
    }
    const real = await realpath(path)
    if (dirname(real) !== filesReal || !isInside(filesReal, real)) {
      return { ok: false, error: "zipPath: escapes the chat files directory" }
    }
    return { ok: true, sessionID: parts.sessionID, name: parts.name, path: real, filesReal }
  } catch {
    return { ok: false, error: "zipPath: could not be read safely" }
  }
}

/** Sum of the bytes under `files/` without following symlinks; null on error. */
export async function chatUsedBytes(filesReal: string): Promise<number | null> {
  let total = 0
  let seen = 0
  const walk = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > MAX_USED_DEPTH) return false
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      seen += 1
      if (seen > MAX_USED_ENTRIES) return false
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!(await walk(path, depth + 1))) return false
        continue
      }
      if (!entry.isFile()) continue
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      total += stat.size
    }
    return true
  }
  try {
    return (await walk(filesReal, 0)) ? total : null
  } catch {
    return null
  }
}

export async function listArchive(
  workspaceDir: string,
  runner: ArchiveRunner,
  zipPath: string,
): Promise<ArchiveOutcome> {
  const source = await resolveArchiveSource(workspaceDir, zipPath)
  if (!source.ok) return source
  const run = await runner("archive_list", { path: source.path })
  if (!run.ok) return run
  return { ok: true, value: { ...run.value, zip: source.name } }
}

export async function extractArchive(
  workspaceDir: string,
  runner: ArchiveRunner,
  call: { zipPath: string; directory: string },
): Promise<ArchiveOutcome> {
  const source = await resolveArchiveSource(workspaceDir, call.zipPath)
  if (!source.ok) return source
  const used = await chatUsedBytes(source.filesReal)
  if (used === null) return { ok: false, error: "io: the chat file usage could not be read" }
  const run = await runner("archive_extract", {
    path: source.path,
    destination: source.filesReal,
    directory: call.directory,
    usedBytes: used,
    quotaBytes: CHAT_QUOTA_PER_CHAT_BYTES,
    maxFileBytes: CHAT_FILE_MAX_BYTES,
  })
  if (!run.ok) return run
  return { ok: true, value: { ...run.value, zip: source.name } }
}
