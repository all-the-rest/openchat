/**
 * Path and name rules for per-chat working files. Kept apart from the store so
 * the security-critical validation can be read (and tested) on its own.
 */
import { extname, isAbsolute, relative } from "node:path"
import { CHAT_FILE_NAME_MAX } from "@openchat/contracts"

/** Layout under `WORKSPACE_DIR`: `chats/<sessionID>/files/` plus `index.json`. */
export const CHATS_DIR_NAME = "chats"
export const FILES_DIR_NAME = "files"
export const CHAT_INDEX_FILE = "index.json"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** A session id becomes one path segment, so the shape is deliberately narrow. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

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
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
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

/** Type comes from the stored extension; the client never supplies a MIME. */
export function mimeForFile(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream"
}

export function isSafeSessionID(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

/**
 * The one route that carries a raw file body. Everything else under
 * `/api/sessions` takes JSON, so the request guard and the node adapter need
 * this predicate to raise their body cap for exactly this path.
 */
export function isChatFilesUploadPath(pathname: string): boolean {
  return /^\/api\/sessions\/[^/]+\/files$/.test(pathname)
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

/** NFC-normalised name, or `null` when the shape is rejected. */
export function normalizeFileName(value: string): string | null {
  const normalized = value.normalize("NFC")
  return isSafeFileName(normalized) ? normalized : null
}

/** `report (1).pdf` for a display name, `report-1.pdf` for the stored name. */
export function suffixed(name: string, suffix: number, parentheses: boolean): string {
  const extension = extname(name)
  const base = extension.length > 0 ? name.slice(0, -extension.length) : name
  return parentheses ? `${base} (${suffix})${extension}` : `${base}-${suffix}${extension}`
}

/** True when `child` is `parent` itself or sits below it after resolution. */
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}
