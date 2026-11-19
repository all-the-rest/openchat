import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ChatFileInfo, ChatFileOrigin, ChatFileQuota } from "@openchat/contracts"
import {
  CHAT_INDEX_FILE,
  CHAT_INDEX_VERSION,
  CHATS_DIR_NAME,
  FILES_DIR_NAME,
  isInside,
  isRecordValue,
  isSafeFileName,
  isSafeSessionID,
  isStoredFile,
  mimeForFile,
  normalizeFileName,
  suffixed,
} from "./chat-files-names"

const MAX_COLLISION_SUFFIX = 99
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export interface ChatFilesStoreOptions {
  /** `WORKSPACE_DIR`; the store appends `chats/<sessionID>`. */
  workspaceDir: string
  quotaPerChatBytes: number
  quotaTotalBytes: number
  maxFileBytes: number
}

export interface ChatFileDraft {
  /** Client-supplied name; the store validates and normalises it. */
  name: string
  bytes: Buffer
  origin: ChatFileOrigin
}

export type ChatFileFailureReason =
  | "invalid-session"
  | "invalid-name"
  | "empty"
  | "too-large"
  | "quota-chat"
  | "quota-total"
  | "name-conflict"
  | "io"

export type ChatFileWriteResult =
  | { ok: true; file: ChatFileInfo }
  | { ok: false; reason: ChatFileFailureReason }

export type ChatFileRemoveResult = "removed" | "not-found"

interface ResolvedDirs {
  filesReal: string
}

interface LocatedFile {
  path: string
  info: ChatFileInfo
}

function alreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST"
}

/**
 * Per-chat working-file storage. Every operation is scoped to one session id,
 * names are single path segments and every resolved path is checked against the
 * chat's real directory. Writes are serialised in-process so the quota check
 * still holds when two uploads arrive together.
 */
export class ChatFilesStore {
  private readonly workspaceDir: string
  private readonly quotaPerChatBytes: number
  private readonly quotaTotalBytes: number
  private readonly maxFileBytes: number
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: ChatFilesStoreOptions) {
    this.workspaceDir = options.workspaceDir
    this.quotaPerChatBytes = options.quotaPerChatBytes
    this.quotaTotalBytes = options.quotaTotalBytes
    this.maxFileBytes = options.maxFileBytes
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => undefined)
    return next
  }

  private chatsRoot(): string {
    return join(this.workspaceDir, CHATS_DIR_NAME)
  }

  /** Resolved chat directory when it exists and is a direct, real child. */
  private async validChatDir(sessionID: string): Promise<string | null> {
    let rootReal: string
    try {
      rootReal = await realpath(this.chatsRoot())
    } catch {
      return null
    }
    const chatPath = join(rootReal, sessionID)
    let stat
    try {
      stat = await lstat(chatPath)
    } catch {
      return null
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const chatReal = await realpath(chatPath)
    if (!isInside(rootReal, chatReal) || dirname(chatReal) !== rootReal) return null
    return chatReal
  }

  async readIndex(sessionID: string): Promise<ChatFileInfo[]> {
    if (!isSafeSessionID(sessionID)) return []
    const chatReal = await this.validChatDir(sessionID)
    if (!chatReal) return []
    try {
      const indexPath = join(chatReal, CHAT_INDEX_FILE)
      const stat = await lstat(indexPath)
      if (!stat.isFile() || stat.isSymbolicLink()) return []
      const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"))
      if (!isRecordValue(parsed) || parsed.version !== CHAT_INDEX_VERSION) return []
      if (!Array.isArray(parsed.files)) return []
      return parsed.files.filter(isStoredFile)
    } catch {
      // Missing or malformed metadata is an empty list; the boot check reports
      // the files that are then left without metadata.
      return []
    }
  }

  private async writeIndex(sessionID: string, files: ChatFileInfo[]): Promise<void> {
    const directory = join(this.chatsRoot(), sessionID)
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
    const temporary = join(directory, `.${CHAT_INDEX_FILE}.${process.pid}.${Date.now()}.tmp`)
    const handle = await open(temporary, "wx", FILE_MODE)
    try {
      await handle.writeFile(
        Buffer.from(JSON.stringify({ version: CHAT_INDEX_VERSION, files })),
      )
    } finally {
      await handle.close()
    }
    await rename(temporary, join(directory, CHAT_INDEX_FILE))
  }

  /** Resolved directory of an existing chat; `null` when it does not exist. */
  private async existingDirs(sessionID: string): Promise<ResolvedDirs | null> {
    const chatReal = await this.validChatDir(sessionID)
    if (!chatReal) return null
    const filesPath = join(chatReal, FILES_DIR_NAME)
    let filesStat
    try {
      filesStat = await lstat(filesPath)
    } catch {
      return null
    }
    if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) return null
    const filesReal = await realpath(filesPath)
    if (!isInside(chatReal, filesReal) || dirname(filesReal) !== chatReal) return null
    return { filesReal }
  }

  /**
   * Creates the directory chain only on a write that already passed quota.
   * Each level is created non-recursively and inspected before the next one, so
   * a pre-existing symlink is rejected instead of followed.
   */
  private async ensureDirs(sessionID: string): Promise<ResolvedDirs> {
    const rootPath = this.chatsRoot()
    await mkdir(rootPath, { recursive: true, mode: DIRECTORY_MODE })
    const rootReal = await realpath(rootPath)
    const chatPath = join(rootReal, sessionID)
    await mkdir(chatPath, { mode: DIRECTORY_MODE }).catch((error: unknown) => {
      if (!alreadyPresent(error)) throw error
    })
    const chatStat = await lstat(chatPath)
    if (!chatStat.isDirectory() || chatStat.isSymbolicLink()) {
      throw new Error("chat directory is not a directory")
    }
    const chatReal = await realpath(chatPath)
    if (!isInside(rootReal, chatReal) || dirname(chatReal) !== rootReal) {
      throw new Error("chat directory escapes the workspace")
    }
    const filesPath = join(chatReal, FILES_DIR_NAME)
    await mkdir(filesPath, { mode: DIRECTORY_MODE }).catch((error: unknown) => {
      if (!alreadyPresent(error)) throw error
    })
    const filesStat = await lstat(filesPath)
    if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) {
      throw new Error("files directory is not a directory")
    }
    const filesReal = await realpath(filesPath)
    if (!isInside(chatReal, filesReal) || dirname(filesReal) !== chatReal) {
      throw new Error("files directory escapes the chat")
    }
    return { filesReal }
  }

  /**
   * Validates one stored file: no symlink, a regular file, one hard link, and
   * a real path still inside `files/`. Metadata is required, so a stray file
   * is reported by the boot check instead of being served.
   */
  private async locate(sessionID: string, name: string): Promise<LocatedFile | null> {
    if (!isSafeFileName(name)) return null
    const dirs = await this.existingDirs(sessionID)
    if (!dirs) return null
    const path = join(dirs.filesReal, name)
    let stat
    try {
      stat = await lstat(path)
    } catch {
      return null
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null
    const real = await realpath(path)
    if (!isInside(dirs.filesReal, real) || dirname(real) !== dirs.filesReal) return null
    const entry = (await this.readIndex(sessionID)).find((file) => file.name === name)
    if (!entry) return null
    return { path: real, info: { ...entry, size: stat.size, mtime: stat.mtime.toISOString() } }
  }

  private async totalUsage(): Promise<number> {
    let entries
    try {
      entries = await readdir(this.chatsRoot(), { withFileTypes: true })
    } catch {
      return 0
    }
    let total = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSessionID(entry.name)) continue
      for (const file of await this.readIndex(entry.name)) total += file.size
    }
    return total
  }

  async usage(sessionID: string): Promise<ChatFileQuota> {
    const files = isSafeSessionID(sessionID) ? await this.readIndex(sessionID) : []
    const usedBytes = files.reduce((sum, file) => sum + file.size, 0)
    return {
      usedBytes,
      quotaBytes: this.quotaPerChatBytes,
      totalUsedBytes: await this.totalUsage(),
      totalQuotaBytes: this.quotaTotalBytes,
    }
  }

  async list(sessionID: string): Promise<ChatFileInfo[]> {
    if (!isSafeSessionID(sessionID)) return []
    const dirs = await this.existingDirs(sessionID)
    if (!dirs) return []
    const visible: ChatFileInfo[] = []
    for (const entry of await this.readIndex(sessionID)) {
      const found = await this.locate(sessionID, entry.name)
      if (found) visible.push(found.info)
    }
    visible.sort((left, right) => {
      if (left.mtime !== right.mtime) return left.mtime < right.mtime ? 1 : -1
      return left.name.localeCompare(right.name)
    })
    return visible
  }

  async write(sessionID: string, draft: ChatFileDraft): Promise<ChatFileWriteResult> {
    if (!isSafeSessionID(sessionID)) return { ok: false, reason: "invalid-session" }
    const name = normalizeFileName(draft.name)
    if (!name) return { ok: false, reason: "invalid-name" }
    const bytes = draft.bytes
    if (bytes.byteLength === 0) return { ok: false, reason: "empty" }
    if (bytes.byteLength > this.maxFileBytes) return { ok: false, reason: "too-large" }

    return this.run<ChatFileWriteResult>(async (): Promise<ChatFileWriteResult> => {
      const entries = await this.readIndex(sessionID)
      const used = entries.reduce((sum, file) => sum + file.size, 0)
      // Both quotas are checked before the directory chain exists, so an
      // over-quota upload leaves no directory, no temp file and no metadata.
      if (used + bytes.byteLength > this.quotaPerChatBytes) {
        return { ok: false, reason: "quota-chat" }
      }
      if ((await this.totalUsage()) + bytes.byteLength > this.quotaTotalBytes) {
        return { ok: false, reason: "quota-total" }
      }

      const dirs = await this.ensureDirs(sessionID)
      let storedName = name
      let displayName = name
      let handle: Awaited<ReturnType<typeof open>> | undefined
      for (let suffix = 1; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
        storedName = suffix === 1 ? name : suffixed(name, suffix, false)
        displayName = suffix === 1 ? name : suffixed(name, suffix, true)
        if (entries.some((file) => file.name === storedName)) continue
        try {
          handle = await open(
            join(dirs.filesReal, storedName),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            FILE_MODE,
          )
          break
        } catch (error) {
          if (!alreadyPresent(error)) throw error
        }
      }
      if (!handle) return { ok: false, reason: "name-conflict" }

      let written = false
      try {
        await handle.writeFile(bytes)
        const stat = await handle.stat()
        const file: ChatFileInfo = {
          name: storedName,
          displayName,
          size: bytes.byteLength,
          mtime: stat.mtime.toISOString(),
          mime: mimeForFile(storedName),
          origin: draft.origin,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }
        await this.writeIndex(sessionID, [...entries, file])
        written = true
        return { ok: true, file }
      } finally {
        await handle.close().catch(() => undefined)
        // A failed metadata write must not leave an unlisted file behind.
        if (!written) await unlink(join(dirs.filesReal, storedName)).catch(() => undefined)
      }
    }).catch((): ChatFileWriteResult => ({ ok: false, reason: "io" }))
  }

  async read(
    sessionID: string,
    name: string,
  ): Promise<{ bytes: Buffer; file: ChatFileInfo } | null> {
    if (!isSafeSessionID(sessionID) || !isSafeFileName(name)) return null
    const found = await this.locate(sessionID, name)
    if (!found) return null
    try {
      const handle = await open(found.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        return { bytes: await handle.readFile(), file: found.info }
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  async remove(sessionID: string, name: string): Promise<ChatFileRemoveResult> {
    if (!isSafeSessionID(sessionID) || !isSafeFileName(name)) return "not-found"
    return this.run(async () => {
      const entries = await this.readIndex(sessionID)
      if (!entries.some((file) => file.name === name)) return "not-found"
      const found = await this.locate(sessionID, name)
      if (found) await unlink(found.path)
      await this.writeIndex(
        sessionID,
        entries.filter((file) => file.name !== name),
      )
      return "removed"
    })
  }

  /**
   * Removes exactly one chat directory. The path is resolved and checked to be
   * a direct child of `chats/` first, so a replaced directory or symlink can
   * never widen the delete.
   */
  async deleteChat(sessionID: string): Promise<boolean> {
    if (!isSafeSessionID(sessionID)) return false
    const chatReal = await this.validChatDir(sessionID)
    if (!chatReal) return false
    await rm(chatReal, { recursive: true, force: true })
    return true
  }
}
