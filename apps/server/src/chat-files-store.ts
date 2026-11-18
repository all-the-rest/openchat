import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
import { dirname, extname, join, relative, isAbsolute } from "node:path"
import type { ChatFileInfo, ChatFileOrigin, ChatFileQuota } from "@openchat/contracts"
import { CHAT_FILE_NAME_MAX } from "@openchat/contracts"

/** Layout under `WORKSPACE_DIR`: `<root>/<sessionID>/files/` plus `index.json`. */
export const CHATS_DIR_NAME = "chats"
export const FILES_DIR_NAME = "files"
export const CHAT_INDEX_FILE = "index.json"
const INDEX_VERSION = 1
const MAX_COLLISION_SUFFIX = 99
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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

function normalizeFileName(value: string): string | null {
  const normalized = value.normalize("NFC")
  return isSafeFileName(normalized) ? normalized : null
}

function suffixed(name: string, suffix: number, parentheses: boolean): string {
  const extension = extname(name)
  const base = extension.length > 0 ? name.slice(0, -extension.length) : name
  return parentheses ? `${base} (${suffix})${extension}` : `${base}-${suffix}${extension}`
}

/** True when `child` is `parent` itself or sits below it after resolution. */
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function isFileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST"
}

interface StoredIndex {
  version: number
  files: ChatFileInfo[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOrigin(value: unknown): value is ChatFileOrigin {
  return value === "upload" || value === "agent"
}

function isStoredFile(value: unknown): value is ChatFileInfo {
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

  private indexFilePath(sessionID: string): string {
    return join(this.chatsRoot(), sessionID, CHAT_INDEX_FILE)
  }

  private async readIndex(sessionID: string): Promise<ChatFileInfo[]> {
    const path = this.indexFilePath(sessionID)
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) return []
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
      if (!isRecord(parsed) || parsed.version !== INDEX_VERSION) return []
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
    const payload: StoredIndex = { version: INDEX_VERSION, files }
    const temporary = join(directory, `.${CHAT_INDEX_FILE}.${process.pid}.${Date.now()}.tmp`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await (await open(temporary, "wx", 0o600)).writeFile(Buffer.from(JSON.stringify(payload)))
    await rename(temporary, join(directory, CHAT_INDEX_FILE))
  }

  /** Resolved directory of an existing chat; `null` when it does not exist. */
  private async existingDirs(sessionID: string): Promise<ResolvedDirs | null> {
    let rootReal: string
    try {
      rootReal = await realpath(this.chatsRoot())
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
    const rootPath = this.chatsRoot()
    await mkdir(join(rootPath, sessionID, FILES_DIR_NAME), { recursive: true, mode: 0o700 })
    const rootReal = await realpath(rootPath)
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
   * Validates one stored file: no symlink, a regular file, one hard link, and
   * a real path still inside `files/`.
   */
  private async locate(
    sessionID: string,
    name: string,
  ): Promise<{ path: string; info: ChatFileInfo; bytes?: Buffer } | null> {
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
    const entries = await this.readIndex(sessionID)
    const entry = entries.find((file) => file.name === name)
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
      const files = await this.readIndex(entry.name)
      for (const file of files) total += file.size
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
    const entries = await this.readIndex(sessionID)
    const dirs = await this.existingDirs(sessionID)
    if (!dirs) return []
    const visible: ChatFileInfo[] = []
    for (const entry of entries) {
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

    return this.run(async () => {
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
            0o600,
          )
          break
        } catch (error) {
          if (!isAlreadyPresent(error)) throw error
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
        await this.writeIndex(sessionID, [...entries, file])
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
    if (!isSafeSessionID(sessionID) || !isSafeFileName(name)) return null
    const found = await this.locate(sessionID, name)
    if (!found) return null
    try {
      const handle = await open(found.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bytes = await handle.readFile()
        return { bytes, file: found.info }
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
      const entry = entries.find((file) => file.name === name)
      if (!entry) return "not-found"
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
    let rootReal: string
    try {
      rootReal = await realpath(this.chatsRoot())
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

  /** File names in `files/` that the index does not know, plus unreadable ones. */
  async audit(): Promise<{ withoutMetadata: string[]; withoutFile: string[] }> {
    const withoutMetadata: string[] = []
    const withoutFile: string[] = []
    let chats
    try {
      chats = await readdir(this.chatsRoot(), { withFileTypes: true })
    } catch {
      return { withoutMetadata, withoutFile }
    }
    for (const chat of chats) {
      if (!chat.isDirectory() || !isSafeSessionID(chat.name)) continue
      const entries = await this.readIndex(chat.name)
      const known = new Set(entries.map((file) => file.name))
      let files
      try {
        files = await readdir(join(this.chatsRoot(), chat.name, FILES_DIR_NAME), {
          withFileTypes: true,
        })
      } catch {
        files = []
      }
      for (const file of files) {
        if (!file.isFile() || !isSafeFileName(file.name)) continue
        if (!known.has(file.name)) withoutMetadata.push(`${chat.name}/${file.name}`)
      }
      for (const entry of entries) {
        try {
          await lstat(join(this.chatsRoot(), chat.name, FILES_DIR_NAME, entry.name))
        } catch {
          withoutFile.push(`${chat.name}/${entry.name}`)
        }
      }
    }
    return { withoutMetadata, withoutFile }
  }
}

export interface OrphanReport {
  orphanDirs: string[]
  withoutMetadata: string[]
  withoutFile: string[]
}

/**
 * Boot check: reports chat directories without a session and files that the
 * index does not know. It only logs; nothing here deletes.
 */
export async function reportChatFileOrphans(
  options: { workspaceDir: string; sessionIDs: readonly string[] },
  log: (message: string) => void = (message) => console.warn(`[openchat] ${message}`),
): Promise<OrphanReport> {
  const store = new ChatFilesStore({
    workspaceDir: options.workspaceDir,
    quotaPerChatBytes: Number.MAX_SAFE_INTEGER,
    quotaTotalBytes: Number.MAX_SAFE_INTEGER,
    maxFileBytes: Number.MAX_SAFE_INTEGER,
  })
  const sessions = new Set(options.sessionIDs)
  const orphanDirs: string[] = []
  let chats
  try {
    chats = await readdir(join(options.workspaceDir, CHATS_DIR_NAME), { withFileTypes: true })
  } catch {
    return { orphanDirs, withoutMetadata: [], withoutFile: [] }
  }
  for (const chat of chats) {
    if (chat.isDirectory() && !sessions.has(chat.name)) orphanDirs.push(chat.name)
  }
  const audit = await store.audit()
  for (const dir of orphanDirs) log(`chat files: directory without a session: ${dir}`)
  for (const file of audit.withoutMetadata) log(`chat files: file without metadata: ${file}`)
  for (const file of audit.withoutFile) log(`chat files: metadata without a file: ${file}`)
  return { orphanDirs, ...audit }
}
