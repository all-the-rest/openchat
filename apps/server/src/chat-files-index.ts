/**
 * The metadata index next to a chat's files. Reads tolerate a missing or
 * malformed index (the boot audit reports what is then unindexed); writes go
 * through a sibling temporary file so a crash cannot leave a half index.
 */
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises"
import { join } from "node:path"
import type { ChatFileInfo, ChatFileOrigin } from "@openchat/contracts"
import {
  CHATS_DIR_NAME,
  CHAT_INDEX_FILE,
  FILES_DIR_NAME,
  isSafeFileName,
  isSafeSessionID,
} from "./chat-files-paths"

const INDEX_VERSION = 1

export interface StoredChatIndex {
  version: number
  files: ChatFileInfo[]
}

export function chatsRoot(workspaceDir: string): string {
  return join(workspaceDir, CHATS_DIR_NAME)
}

export function chatDirectory(workspaceDir: string, sessionID: string): string {
  return join(chatsRoot(workspaceDir), sessionID)
}

export function filesDirectory(workspaceDir: string, sessionID: string): string {
  return join(chatDirectory(workspaceDir, sessionID), FILES_DIR_NAME)
}

function indexFile(workspaceDir: string, sessionID: string): string {
  return join(chatDirectory(workspaceDir, sessionID), CHAT_INDEX_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOrigin(value: unknown): value is ChatFileOrigin {
  return value === "upload" || value === "agent"
}

/** A stored row must satisfy the same rules the store enforces on write. */
export function isStoredFile(value: unknown): value is ChatFileInfo {
  if (!isRecord(value)) return false
  return (
    typeof value.name === "string" &&
    isSafeFileName(value.name) &&
    typeof value.displayName === "string" &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.mtime === "string" &&
    typeof value.mime === "string" &&
    isOrigin(value.origin) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  )
}

/** Missing or malformed metadata reads as an empty list, never as an error. */
export async function readChatIndex(
  workspaceDir: string,
  sessionID: string,
): Promise<ChatFileInfo[]> {
  if (!isSafeSessionID(sessionID)) return []
  const path = indexFile(workspaceDir, sessionID)
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return []
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isRecord(parsed) || parsed.version !== INDEX_VERSION) return []
    if (!Array.isArray(parsed.files)) return []
    return parsed.files.filter(isStoredFile)
  } catch {
    return []
  }
}

/** Creates the chat directory on demand; callers only write after quota. */
export async function writeChatIndex(
  workspaceDir: string,
  sessionID: string,
  files: ChatFileInfo[],
): Promise<void> {
  const directory = chatDirectory(workspaceDir, sessionID)
  const payload: StoredChatIndex = { version: INDEX_VERSION, files }
  const temporary = join(
    directory,
    `.${CHAT_INDEX_FILE}.${process.pid}.${Date.now()}.tmp`,
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // `mode` only applies on creation; an existing directory is tightened here.
  await chmod(directory, 0o700)
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(Buffer.from(JSON.stringify(payload)))
  } finally {
    await handle.close()
  }
  await rename(temporary, join(directory, CHAT_INDEX_FILE))
}

/** Bytes indexed across every chat, used for the workspace-wide quota. */
export async function totalIndexedBytes(workspaceDir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(chatsRoot(workspaceDir), { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSessionID(entry.name)) continue
    const files = await readChatIndex(workspaceDir, entry.name)
    for (const file of files) total += file.size
  }
  return total
}
