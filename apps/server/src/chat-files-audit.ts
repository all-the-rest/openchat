import { lstat, readdir } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { join } from "node:path"
import type { ChatFileInfo } from "@openchat/contracts"
import { CHATS_DIR_NAME, FILES_DIR_NAME, isSafeSessionID } from "./chat-files-names"

export interface ChatFilesAudit {
  /** Chat directories with no matching session. */
  withoutSession: string[]
  /** Entries on disk that the index does not know (including symlinks). */
  withoutMetadata: string[]
  /** Index rows whose file is missing, or no longer a regular file. */
  withoutFile: string[]
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

/**
 * Read-only comparison of the workspace with the sessions the host reports.
 * It never deletes: the caller only logs the result.
 */
export async function auditChatFiles(
  workspaceDir: string,
  knownSessionIDs: Iterable<string>,
  readIndex: (sessionID: string) => Promise<ChatFileInfo[]>,
): Promise<ChatFilesAudit> {
  const sessions = new Set(knownSessionIDs)
  const withoutSession: string[] = []
  const withoutMetadata: string[] = []
  const withoutFile: string[] = []
  const root = join(workspaceDir, CHATS_DIR_NAME)
  let chats
  try {
    chats = await readdir(root, { withFileTypes: true })
  } catch {
    return { withoutSession, withoutMetadata, withoutFile }
  }
  for (const chat of chats) {
    if (!chat.isDirectory() || chat.isSymbolicLink()) {
      withoutSession.push(chat.name)
      continue
    }
    if (!isSafeSessionID(chat.name) || !sessions.has(chat.name)) {
      withoutSession.push(chat.name)
      continue
    }
    const entries = await readIndex(chat.name)
    const known = new Set(entries.map((file) => file.name))
    const filesDir = join(root, chat.name, FILES_DIR_NAME)
    let files: Dirent[]
    try {
      files = await readdir(filesDir, { withFileTypes: true })
    } catch {
      files = []
    }
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink() || !known.has(file.name)) {
        withoutMetadata.push(`${chat.name}/${file.name}`)
      }
    }
    for (const entry of entries) {
      try {
        const stat = await lstat(join(filesDir, entry.name))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          withoutFile.push(`${chat.name}/${entry.name}`)
        }
      } catch (error) {
        if (missing(error)) withoutFile.push(`${chat.name}/${entry.name}`)
      }
    }
  }
  return { withoutSession, withoutMetadata, withoutFile }
}
