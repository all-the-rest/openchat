import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"

/**
 * File I/O for the memory store: one fixed directory, 0700/0600, atomic
 * replace through a sibling temporary file, and a cross-process lock that
 * makes a read-modify-write cycle safe between the BFF and the MCP server.
 */

export const FACTS_FILE = "facts.jsonl"
export const INDEX_FILE = "INDEX.md"
export const AUDIT_FILE = "audit.jsonl"
export const LOCK_FILE = ".memory.lock"

/** One fact per line; a trailing newline keeps the file diff-friendly. */
export function encodeJsonl(rows: readonly unknown[]): string {
  if (rows.length === 0) return ""
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
}

export function parseJsonl<T>(
  text: string,
  accept: (value: unknown) => value is T,
): T[] {
  const rows: T[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (accept(parsed)) rows.push(parsed)
    } catch {
      // A corrupt line is skipped; the rest of the store stays readable.
    }
  }
  return rows
}

export async function ensureMemoryDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("memory directory must be a real directory")
  }
  await chmod(dir, 0o700)
}

/** A regular, singly-linked file, or `null`; symlinks are never followed. */
export async function readRegularFile(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

/**
 * Replace one file atomically: write a same-directory temporary file, fsync on
 * close, then rename over the target. A crash leaves either the old or the new
 * content, never a half file.
 */
export async function writeAtomic(path: string, contents: string): Promise<void> {
  const directory = join(path, "..")
  const base = path.slice(directory.length + 1)
  const temporary = join(
    directory,
    `.${base}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  )
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
}

export async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(line.endsWith("\n") ? line : `${line}\n`)
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 20

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function breakStaleLock(lockPath: string): Promise<void> {
  try {
    const stat = await lstat(lockPath)
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await unlink(lockPath).catch(() => undefined)
    }
  } catch {
    // The holder released it between the open attempt and this check.
  }
}

/**
 * Serialises one read-modify-write cycle. The lock is a 0600 file created with
 * `O_EXCL`; a crashed holder is broken after ten seconds. Cross-process, not
 * only in-process: the BFF and the MCP server write the same directory.
 */
export async function withMemoryLock<T>(
  dir: string,
  task: () => Promise<T>,
): Promise<T> {
  await ensureMemoryDir(dir)
  const lockPath = join(dir, LOCK_FILE)
  const started = Date.now()
  for (;;) {
    try {
      const handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(`${process.pid}\n`)
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== "EEXIST") throw error
      await breakStaleLock(lockPath)
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error("memory store is locked by another writer")
      }
      await pause(LOCK_RETRY_MS)
    }
  }
  try {
    return await task()
  } finally {
    await unlink(lockPath).catch(() => undefined)
  }
}
