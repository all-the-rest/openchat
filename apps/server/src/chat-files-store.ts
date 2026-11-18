/**
 * Per-chat working-file storage. Every operation is scoped to one session id,
 * names are single path segments and every resolved path is checked against
 * the chat's real directory. Writes are serialised in-process so the quota
 * check still holds when two uploads arrive together.
 */
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ChatFileInfo, ChatFileOrigin, ChatFileQuota } from "@openchat/contracts"
import {
  chatDirectory,
  chatsRoot,
  filesDirectory,
  readChatIndex,
  totalIndexedBytes,
  writeChatIndex,
} from "./chat-files-index"
import {
  FILES_DIR_NAME,
  isInside,
  isSafeFileName,
  isSafeSessionID,
  mimeForFile,
  normalizeFileName,
  suffixed,
} from "./chat-files-paths"

const MAX_COLLISION_SUFFIX = 99

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
  chatReal: string
  filesReal: string
}

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

  /**
   * Resolved directory of an existing chat; `null` when it does not exist or
   * when any component is a symlink or resolves outside its parent.
   */
  private async existingDirs(sessionID: string): Promise<ResolvedDirs | null> {
    let rootReal: string
    try {
      rootReal = await realpath(chatsRoot(this.workspaceDir))
    } catch {
      return null
    }
    const chatPath = join(rootReal, sessionID)
    let chatStat
    try {
      chatStat = await lstat(chatPath)
    } catch {
      return null
    }
    if (!chatStat.isDirectory() || chatStat.isSymbolicLink()) return null
    const chatReal = await realpath(chatPath)
    if (!isInside(rootReal, chatReal) || dirname(chatReal) !== rootReal) return null
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
    return { chatReal, filesReal }
  }

  /** Creates the directory chain only on a write that already passed quota. */
  private async ensureDirs(sessionID: string): Promise<ResolvedDirs> {
    await mkdir(filesDirectory(this.workspaceDir, sessionID), {
      recursive: true,
      mode: 0o700,
    })
    // Mode only applies on creation, and a host- or user-created directory may
    // already exist: enforce 0700 on both levels before anything is written.
    await chmod(chatDirectory(this.workspaceDir, sessionID), 0o700)
    await chmod(filesDirectory(this.workspaceDir, sessionID), 0o700)
    const rootReal = await realpath(chatsRoot(this.workspaceDir))
    const chatPath = join(rootReal, sessionID)
    const chatStat = await lstat(chatPath)
    if (!chatStat.isDirectory() || chatStat.isSymbolicLink()) {
      throw new Error("chat directory is not a directory")
    }
    const chatReal = await realpath(chatPath)
    if (!isInside(rootReal, chatReal) || dirname(chatReal) !== rootReal) {
      throw new Error("chat directory escapes the workspace")
    }
    const filesReal = await realpath(join(chatReal, FILES_DIR_NAME))
    if (!isInside(chatReal, filesReal) || dirname(filesReal) !== chatReal) {
      throw new Error("files directory escapes the chat")
    }
    return { chatReal, filesReal }
  }

  /**
   * Validates one stored file: no symlink, a regular file with exactly one hard
   * link, and a real path still directly inside `files/`. The size and mtime
   * come from the filesystem, the rest from the index.
   */
  private async inspect(
    filesReal: string,
    entry: ChatFileInfo,
  ): Promise<ChatFileInfo | null> {
    const path = join(filesReal, entry.name)
    let stat
    try {
      stat = await lstat(path)
    } catch {
      return null
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null
    const real = await realpath(path)
    if (!isInside(filesReal, real) || dirname(real) !== filesReal) return null
    return { ...entry, size: stat.size, mtime: stat.mtime.toISOString() }
  }

  /** One indexed file, resolved for a read or delete; `null` when invalid. */
  private async locate(
    sessionID: string,
    name: string,
  ): Promise<{ path: string; info: ChatFileInfo } | null> {
    if (!isSafeFileName(name)) return null
    const dirs = await this.existingDirs(sessionID)
    if (!dirs) return null
    const entry = (await readChatIndex(this.workspaceDir, sessionID)).find(
      (file) => file.name === name,
    )
    if (!entry) return null
    const info = await this.inspect(dirs.filesReal, entry)
    if (!info) return null
    return { path: join(dirs.filesReal, name), info }
  }

  async usage(sessionID: string): Promise<ChatFileQuota> {
    const files = isSafeSessionID(sessionID)
      ? await readChatIndex(this.workspaceDir, sessionID)
      : []
    return {
      usedBytes: files.reduce((sum, file) => sum + file.size, 0),
      quotaBytes: this.quotaPerChatBytes,
      totalUsedBytes: await totalIndexedBytes(this.workspaceDir),
      totalQuotaBytes: this.quotaTotalBytes,
    }
  }

  async list(sessionID: string): Promise<ChatFileInfo[]> {
    if (!isSafeSessionID(sessionID)) return []
    const entries = await readChatIndex(this.workspaceDir, sessionID)
    const dirs = await this.existingDirs(sessionID)
    if (!dirs) return []
    const visible: ChatFileInfo[] = []
    for (const entry of entries) {
      const info = await this.inspect(dirs.filesReal, entry)
      if (info) visible.push(info)
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

    return this.run(async (): Promise<ChatFileWriteResult> => {
      const entries = await readChatIndex(this.workspaceDir, sessionID)
      const used = entries.reduce((sum, file) => sum + file.size, 0)
      // Both quotas are checked before the directory chain exists, so an
      // over-quota upload leaves no directory, no temporary file, no metadata.
      if (used + bytes.byteLength > this.quotaPerChatBytes) {
        return { ok: false, reason: "quota-chat" }
      }
      if ((await totalIndexedBytes(this.workspaceDir)) + bytes.byteLength > this.quotaTotalBytes) {
        return { ok: false, reason: "quota-total" }
      }

      const dirs = await this.ensureDirs(sessionID)
      let storedName = name
      let displayName = name
      let handle: Awaited<ReturnType<typeof open>> | undefined
      // Attempt 0 keeps the plain name; the first collision becomes `-1`.
      for (let attempt = 0; attempt <= MAX_COLLISION_SUFFIX; attempt += 1) {
        storedName = attempt === 0 ? name : suffixed(name, attempt, false)
        displayName = attempt === 0 ? name : suffixed(name, attempt, true)
        // A suffixed name may pass the 200-code-point cap; giving up is safer
        // than indexing a row whose name the next read would reject.
        if (!isSafeFileName(storedName)) break
        if (entries.some((file) => file.name === storedName)) continue
        try {
          handle = await open(
            join(dirs.filesReal, storedName),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          )
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code
          if (code !== "EEXIST") throw error
        }
      }
      if (!handle) return { ok: false, reason: "name-conflict" }

      try {
        await handle.writeFile(bytes)
        const stat = await handle.stat()
        await handle.close()
        const file: ChatFileInfo = {
          name: storedName,
          displayName,
          size: bytes.byteLength,
          mtime: stat.mtime.toISOString(),
          mime: mimeForFile(storedName),
          origin: draft.origin,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }
        await writeChatIndex(this.workspaceDir, sessionID, [...entries, file])
        return { ok: true, file }
      } catch (error) {
        await handle.close().catch(() => undefined)
        await unlink(join(dirs.filesReal, storedName)).catch(() => undefined)
        throw error
      }
    }).catch((): ChatFileWriteResult => ({ ok: false, reason: "io" }))
  }

  async read(
    sessionID: string,
    name: string,
  ): Promise<{ bytes: Buffer; file: ChatFileInfo } | null> {
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
    return this.run(async (): Promise<ChatFileRemoveResult> => {
      const entries = await readChatIndex(this.workspaceDir, sessionID)
      if (!entries.some((file) => file.name === name)) return "not-found"
      const dirs = await this.existingDirs(sessionID)
      if (dirs) {
        const path = join(dirs.filesReal, name)
        try {
          const stat = await lstat(path)
          // Only a regular, singly-linked file is unlinked. A replaced entry is
          // left alone and the boot audit reports it once its metadata is gone.
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
            await unlink(path)
          }
        } catch {
          // Already gone: dropping the metadata is the whole delete.
        }
      }
      await writeChatIndex(
        this.workspaceDir,
        sessionID,
        entries.filter((file) => file.name !== name),
      )
      return "removed"
    })
  }
}
