/**
 * Chat-directory housekeeping: removing one chat, auditing indexed files and
 * the read-only boot report. Nothing here deletes during the boot check.
 */
import type { Dirent } from "node:fs"
import { lstat, readdir, realpath, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  chatsRoot,
  filesDirectory,
  readChatIndex,
} from "./chat-files-index"
import {
  CHATS_DIR_NAME,
  FILES_DIR_NAME,
  isInside,
  isSafeSessionID,
} from "./chat-files-paths"

export interface ChatFilesAudit {
  /** Files in `files/` that the index does not mention. */
  withoutMetadata: string[]
  /** Index rows whose file is missing or unreadable. */
  withoutFile: string[]
}

export interface OrphanReport extends ChatFilesAudit {
  /** Chat directories with no matching session. */
  orphanDirs: string[]
}

/** File names in every `files/` directory that the index does not know. */
export async function auditChatFiles(workspaceDir: string): Promise<ChatFilesAudit> {
  const withoutMetadata: string[] = []
  const withoutFile: string[] = []
  let chats
  try {
    chats = await readdir(chatsRoot(workspaceDir), { withFileTypes: true })
  } catch {
    return { withoutMetadata, withoutFile }
  }
  for (const chat of chats) {
    if (!chat.isDirectory() || !isSafeSessionID(chat.name)) continue
    const entries = await readChatIndex(workspaceDir, chat.name)
    const known = new Set(entries.map((file) => file.name))
    const prefix = `${chat.name}/${FILES_DIR_NAME}`
    let files: Dirent[]
    try {
      files = await readdir(filesDirectory(workspaceDir, chat.name), {
        withFileTypes: true,
      })
    } catch {
      files = []
    }
    for (const file of files) {
      if (!known.has(file.name)) withoutMetadata.push(`${prefix}/${file.name}`)
    }
    for (const entry of entries) {
      try {
        await lstat(join(filesDirectory(workspaceDir, chat.name), entry.name))
      } catch {
        withoutFile.push(`${prefix}/${entry.name}`)
      }
    }
  }
  return { withoutMetadata, withoutFile }
}

/**
 * Removes exactly one chat directory. The path is resolved and checked to be a
 * direct child of `chats/` first, so a replaced directory or symlink can never
 * widen the delete.
 */
export async function deleteChatFiles(
  workspaceDir: string,
  sessionID: string,
): Promise<boolean> {
  if (!isSafeSessionID(sessionID)) return false
  let rootReal: string
  try {
    rootReal = await realpath(chatsRoot(workspaceDir))
  } catch {
    return false
  }
  const chatPath = join(rootReal, sessionID)
  let stat
  try {
    stat = await lstat(chatPath)
  } catch {
    return false
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  const chatReal = await realpath(chatPath)
  if (!isInside(rootReal, chatReal) || dirname(chatReal) !== rootReal) return false
  await rm(chatReal, { recursive: true, force: true })
  return true
}

/**
 * Boot check: reports chat directories without a session, files without
 * metadata and metadata without a file. It only logs; nothing is deleted.
 * A missing `chats/` directory is a normal first boot, not an orphan.
 */
export async function reportChatFileOrphans(
  options: { workspaceDir: string; sessionIDs: readonly string[] },
  log: (message: string) => void = (message) => console.warn(`[openchat] ${message}`),
): Promise<OrphanReport> {
  const sessions = new Set(options.sessionIDs)
  const orphanDirs: string[] = []
  const audit: ChatFilesAudit = { withoutMetadata: [], withoutFile: [] }
  try {
    const chats = await readdir(join(options.workspaceDir, CHATS_DIR_NAME), {
      withFileTypes: true,
    })
    for (const chat of chats) {
      // Dot-directories are bookkeeping the server keeps beside the chats (the
      // usage ledger lives in `chats/.usage`), never a chat.
      if (chat.isDirectory() && !chat.name.startsWith(".") && !sessions.has(chat.name)) {
        orphanDirs.push(chat.name)
      }
    }
    Object.assign(audit, await auditChatFiles(options.workspaceDir))
  } catch {
    return { orphanDirs, withoutMetadata: [], withoutFile: [] }
  }

  for (const dir of orphanDirs) log(`chat files: directory without a session: ${dir}`)
  for (const file of audit.withoutMetadata) {
    log(`chat files: file without metadata: ${file}`)
  }
  for (const file of audit.withoutFile) log(`chat files: metadata without a file: ${file}`)
  return { orphanDirs, ...audit }
}
