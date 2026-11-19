import { extname, isAbsolute, relative, sep } from "node:path"
import type { ChatFileInfo, ChatFileOrigin } from "@openchat/contracts"
import { CHAT_FILE_NAME_MAX } from "@openchat/contracts"

/** Layout under `WORKSPACE_DIR`: `chats/<sessionID>/files/` plus `index.json`. */
export const CHATS_DIR_NAME = "chats"
export const FILES_DIR_NAME = "files"
export const CHAT_INDEX_FILE = "index.json"
export const CHAT_INDEX_VERSION = 1

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const SHA256_HEX = /^[0-9a-f]{64}$/
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ORIGINS: readonly ChatFileOrigin[] = ["upload", "agent"]

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
}

export function mimeForFile(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream"
}

/** A session id becomes one path segment, so the shape is deliberately narrow. */
export function isSafeSessionID(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

/**
 * One normalised file name: a single segment, no control characters, no
 * leading dot and no surrounding whitespace. Rejecting instead of rewriting
 * keeps the name the client asked for and the stored name identical.
 */
export function isSafeFileName(value: string): boolean {
  if (value.length === 0 || [...value].length > CHAT_FILE_NAME_MAX) return false
  if (value !== value.trim()) return false
  if (value === "." || value === "..") return false
  if (value.startsWith(".")) return false
  if (value.includes("/") || value.includes("\\")) return false
  return !CONTROL_CHARACTERS.test(value)
}

/** NFC-normalises a draft name; `null` when the result is not a safe segment. */
export function normalizeFileName(value: string): string | null {
  const normalized = value.normalize("NFC")
  return isSafeFileName(normalized) ? normalized : null
}

/** Collision suffix: `report-2.docx` on disk, `report (2).docx` in the list. */
export function suffixed(name: string, suffix: number, parentheses: boolean): string {
  const extension = extname(name)
  const base = extension.length > 0 ? name.slice(0, -extension.length) : name
  return parentheses ? `${base} (${suffix})${extension}` : `${base}-${suffix}${extension}`
}

/** True when `child` is `parent` itself or sits below it after resolution. */
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** One index row; anything else is ignored instead of being served blindly. */
export function isStoredFile(value: unknown): value is ChatFileInfo {
  if (!isRecordValue(value)) return false
  const { name, displayName, size, mtime, mime, origin, sha256 } = value
  if (typeof name !== "string" || !isSafeFileName(name)) return false
  if (typeof displayName !== "string" || displayName.trim().length === 0) return false
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return false
  if (typeof mtime !== "string" || mtime.length === 0) return false
  if (typeof mime !== "string" || mime.length === 0) return false
  if (typeof origin !== "string" || !ORIGINS.includes(origin as ChatFileOrigin)) return false
  return typeof sha256 === "string" && SHA256_HEX.test(sha256)
}
