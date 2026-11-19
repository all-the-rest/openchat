import {
  appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, statSync, writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { MemoryAuditEntry, MemoryFact } from "@openchat/contracts"
import { isAuditEntry, isFact } from "./memory-model"

/**
 * Byte layer of the memory store. Facts grow by O(1) appends instead of a
 * read-rewrite cycle per mutation, the facts file has a hard write cap, and the
 * audit view reads only a bounded tail. Compaction is the one path that
 * rewrites `facts.jsonl`; it goes through a temp file and rename.
 */
export const FACTS_FILE = "facts.jsonl"
export const AUDIT_FILE = "audit.jsonl"
export const INDEX_FILE = "INDEX.md"
/** Default hard cap for `facts.jsonl`; `MEMORY_MAX_FACTS_BYTES` overrides it. */
export const DEFAULT_MEMORY_MAX_FACTS_BYTES = 64 * 1024 * 1024
/** Newest audit lines the UI receives; the export keeps the same bound. */
export const MEMORY_AUDIT_READ_LINES = 200
/** Stable code the route maps to HTTP 507. The message carries no path. */
export const MEMORY_STORE_FULL = "memory_store_full"
export const MEMORY_STORE_FULL_MESSAGE = "Memory storage is full"

const AUDIT_TAIL_CHUNK_BYTES = 64 * 1024
/** Upper bound on a tail read, so a pathological file cannot stall a page. */
const AUDIT_TAIL_MAX_BYTES = 8 * 1024 * 1024
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Thrown before anything is appended; a refused write leaves the file intact. */
export class MemoryStoreFullError extends Error {
  readonly code = MEMORY_STORE_FULL
  constructor() {
    super(MEMORY_STORE_FULL_MESSAGE)
    this.name = "MemoryStoreFullError"
  }
}

export interface MemoryFilesOptions {
  dir: string
  /** Defaults to `DEFAULT_MEMORY_MAX_FACTS_BYTES`. */
  maxFactsBytes?: number
}

function lineBytes(line: string): number {
  return Buffer.byteLength(`${line}\n`, "utf8")
}

/**
 * Reads at most `maxLines` complete lines from the end of a file. The scan
 * walks backwards in chunks, so its cost is bounded by the returned lines and
 * not by the file size. A chunk that starts inside a line drops that partial
 * line; a tail that exceeds the byte ceiling returns what was read so far.
 */
export function readAuditTail(
  path: string, maxLines: number, chunkSize = AUDIT_TAIL_CHUNK_BYTES,
): string[] {
  if (maxLines <= 0 || !existsSync(path)) return []
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    let position = size
    let scanned = 0
    let newlines = 0
    let text = ""
    while (position > 0 && scanned < AUDIT_TAIL_MAX_BYTES) {
      const take = Math.min(chunkSize, position, AUDIT_TAIL_MAX_BYTES - scanned)
      position -= take
      scanned += take
      const buffer = Buffer.allocUnsafe(take)
      readSync(fd, buffer, 0, take, position)
      const piece = buffer.toString("utf8")
      text = piece + text
      newlines += piece.split("\n").length - 1
      if (newlines > maxLines) break
    }
    let lines = text.split("\n")
    // A stop before offset 0 means the first entry is a partial line.
    if (position > 0) lines = lines.slice(1)
    return lines.map((line) => line.trim()).filter((line) => line.length > 0).slice(-maxLines)
  } finally {
    closeSync(fd)
  }
}

export function createMemoryFiles(options: MemoryFilesOptions) {
  const dir = options.dir
  const maxFactsBytes = options.maxFactsBytes ?? DEFAULT_MEMORY_MAX_FACTS_BYTES
  const factsPath = join(dir, FACTS_FILE)
  const auditPath = join(dir, AUDIT_FILE)
  const indexPath = join(dir, INDEX_FILE)

  function ensureDir(): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    chmodSync(dir, DIR_MODE)
  }

  function writeAtomic(path: string, content: string): void {
    ensureDir()
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, content, { mode: FILE_MODE })
    chmodSync(temp, FILE_MODE)
    renameSync(temp, path)
    chmodSync(path, FILE_MODE)
  }

  function factsBytes(): number {
    return existsSync(factsPath) ? statSync(factsPath).size : 0
  }

  function needsLeadingNewline(path: string): boolean {
    if (!existsSync(path)) return false
    const fd = openSync(path, "r")
    try {
      const size = fstatSync(fd).size
      if (size === 0) return false
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      return last[0] !== 0x0a
    } finally {
      closeSync(fd)
    }
  }

  /** One `appendFileSync` call per batch; the file is never read to append. */
  function appendRaw(path: string, lines: string[]): void {
    if (lines.length === 0) return
    ensureDir()
    const prefix = needsLeadingNewline(path) ? "\n" : ""
    appendFileSync(path, prefix + lines.map((line) => `${line}\n`).join(""), { mode: FILE_MODE })
    chmodSync(path, FILE_MODE)
  }

  function appendFacts(lines: string[]): void {
    if (lines.length === 0) return
    const prefix = needsLeadingNewline(factsPath) ? 1 : 0
    const projected = factsBytes() + prefix + lines.reduce((sum, line) => sum + lineBytes(line), 0)
    // Refusal happens here, before the first byte reaches the file.
    if (projected > maxFactsBytes) throw new MemoryStoreFullError()
    appendRaw(factsPath, lines)
  }

  /** Compaction: one latest row per surviving fact, still capped. */
  function replaceFacts(lines: string[]): void {
    const content = lines.map((line) => `${line}\n`).join("")
    if (Buffer.byteLength(content, "utf8") > maxFactsBytes) throw new MemoryStoreFullError()
    writeAtomic(factsPath, content)
  }

  function appendAudit(entry: MemoryAuditEntry): void {
    appendRaw(auditPath, [JSON.stringify(entry)])
  }

  function readFacts(): { facts: MemoryFact[]; corrupt: number } {
    if (!existsSync(factsPath)) return { facts: [], corrupt: 0 }
    const facts: MemoryFact[] = []
    let corrupt = 0
    for (const line of readFileSync(factsPath, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isFact(parsed)) facts.push(parsed)
        else corrupt += 1
      } catch { corrupt += 1 }
    }
    return { facts, corrupt }
  }

  function readAudit(limit = MEMORY_AUDIT_READ_LINES): MemoryAuditEntry[] {
    const entries: MemoryAuditEntry[] = []
    for (const line of readAuditTail(auditPath, limit)) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (isAuditEntry(parsed)) entries.push(parsed)
      } catch { /* skip corrupt line */ }
    }
    return entries
  }

  return {
    dir, factsPath, auditPath, indexPath, maxFactsBytes,
    factsBytes, appendFacts, replaceFacts, appendAudit, readFacts, readAudit,
    writeIndex: (content: string) => writeAtomic(indexPath, content),
  }
}

export type MemoryFiles = ReturnType<typeof createMemoryFiles>
