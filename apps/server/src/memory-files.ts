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
/**
 * Default hard cap for `facts.jsonl`; `MEMORY_MAX_FACTS_BYTES` overrides it.
 * Parsed facts cost several times their on-disk bytes and the BFF is capped at
 * 512 MiB, so this is a heap guard as much as a disk guard: 8 MiB of JSONL is
 * a few hundred thousand parsed bytes at most, well inside the process budget.
 */
export const DEFAULT_MEMORY_MAX_FACTS_BYTES = 8 * 1024 * 1024
/**
 * Default read-side cap on parsed facts. `current()` runs once or twice per
 * request and `GET /api/memory` serialises every fact, so only the newest
 * `DEFAULT_MEMORY_MAX_FACTS` rows are parsed; older rows stay on disk and are
 * reached by prune, never by a page load.
 */
export const DEFAULT_MEMORY_MAX_FACTS = 20_000
/** Newest audit lines the UI receives; the export keeps the same bound. */
export const MEMORY_AUDIT_READ_LINES = 200
/**
 * Audit rows are kept under this many bytes; rotations rewrite the file with
 * the newest rows that fit. `audit.jsonl` is a view, not a log of record: the
 * facts file remains the source of truth.
 */
export const DEFAULT_MEMORY_MAX_AUDIT_BYTES = 2 * 1024 * 1024
/** Stable code the route maps to HTTP 507. The message carries no path. */
export const MEMORY_STORE_FULL = "memory_store_full"
export const MEMORY_STORE_FULL_MESSAGE = "Memory storage is full"

const TAIL_CHUNK_BYTES = 64 * 1024
/** Upper bound on an audit tail read, so a pathological file cannot stall a page. */
const AUDIT_TAIL_MAX_BYTES = 8 * 1024 * 1024
/**
 * Upper bound on a facts tail scan. The window has to be large enough to find
 * `DEFAULT_MEMORY_MAX_FACTS` rows in a legacy 64 MiB file, and small enough
 * that one read cannot pull the whole file into a string.
 */
const FACTS_TAIL_MAX_BYTES = 16 * 1024 * 1024
/** Rows considered by one audit rotation; the cap itself is byte-based. */
const AUDIT_ROTATE_MAX_LINES = 20_000
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
  /** Facts parsed per read; defaults to `DEFAULT_MEMORY_MAX_FACTS`. */
  maxFacts?: number
  /** Bytes kept in `audit.jsonl`; defaults to `DEFAULT_MEMORY_MAX_AUDIT_BYTES`. */
  maxAuditBytes?: number
}

function lineBytes(line: string): number {
  return Buffer.byteLength(`${line}\n`, "utf8")
}

interface TailRead {
  lines: string[]
  /** Older lines exist before the window; they were not scanned. */
  truncated: boolean
}

/**
 * Reads at most `maxLines` complete lines from the end of a file. The scan
 * walks backwards in chunks, so its cost is bounded by the returned lines and
 * the byte ceiling, not by the file size. A chunk that starts inside a line
 * drops that partial line.
 */
function readTailLines(
  path: string, maxLines: number, chunkSize: number, maxScanBytes: number,
): TailRead {
  if (maxLines <= 0 || !existsSync(path)) return { lines: [], truncated: false }
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    let position = size
    let scanned = 0
    let newlines = 0
    let text = ""
    while (position > 0 && scanned < maxScanBytes) {
      const take = Math.min(chunkSize, position, maxScanBytes - scanned)
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
    const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0)
    return {
      lines: trimmed.slice(-maxLines),
      truncated: position > 0 || trimmed.length > maxLines,
    }
  } finally {
    closeSync(fd)
  }
}

/** Newest `maxLines` audit lines, oldest first. */
export function readAuditTail(
  path: string, maxLines: number, chunkSize = TAIL_CHUNK_BYTES,
): string[] {
  return readTailLines(path, maxLines, chunkSize, AUDIT_TAIL_MAX_BYTES).lines
}

export function createMemoryFiles(options: MemoryFilesOptions) {
  const dir = options.dir
  const maxFactsBytes = options.maxFactsBytes ?? DEFAULT_MEMORY_MAX_FACTS_BYTES
  const maxFacts = Math.max(1, options.maxFacts ?? DEFAULT_MEMORY_MAX_FACTS)
  const maxAuditBytes = Math.max(1, options.maxAuditBytes ?? DEFAULT_MEMORY_MAX_AUDIT_BYTES)
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

  /**
   * Keeps `audit.jsonl` under its byte cap by rewriting the newest rows that
   * fit through the same temp-file-and-rename path as every other rewrite. A
   * legacy file far above the cap shrinks in one rotation: the scan is bounded
   * by the tail-reader ceiling, so the rewrite never has to load it whole.
   */
  function rotateAudit(): void {
    if (!existsSync(auditPath) || statSync(auditPath).size <= maxAuditBytes) return
    const { lines } = readTailLines(
      auditPath, AUDIT_ROTATE_MAX_LINES, TAIL_CHUNK_BYTES, AUDIT_TAIL_MAX_BYTES,
    )
    const kept: string[] = []
    let bytes = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] as string
      const size = lineBytes(line)
      if (bytes + size > maxAuditBytes) break
      kept.unshift(line)
      bytes += size
    }
    writeAtomic(auditPath, kept.map((line) => `${line}\n`).join(""))
  }

  function appendAudit(entry: MemoryAuditEntry): void {
    appendRaw(auditPath, [JSON.stringify(entry)])
    rotateAudit()
  }

  /**
   * Newest `maxFacts` rows, oldest first inside that window. The scan starts at
   * the end because every mutation appends and the last row per id wins, so the
   * newest window carries the current state. Rows before it stay on disk.
   */
  function readFacts(): { facts: MemoryFact[]; corrupt: number; truncated: boolean } {
    const { lines, truncated } = readTailLines(
      factsPath, maxFacts, TAIL_CHUNK_BYTES, FACTS_TAIL_MAX_BYTES,
    )
    const facts: MemoryFact[] = []
    let corrupt = 0
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (isFact(parsed)) facts.push(parsed)
        else corrupt += 1
      } catch { corrupt += 1 }
    }
    return { facts, corrupt, truncated }
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

  /** The stored push layer, or `null` when it was never written. */
  function readIndex(): string | null {
    return existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null
  }

  return {
    dir, factsPath, auditPath, indexPath, maxFactsBytes, maxFacts, maxAuditBytes,
    factsBytes, appendFacts, replaceFacts, appendAudit, readFacts, readAudit, readIndex,
    writeIndex: (content: string) => writeAtomic(indexPath, content),
  }
}

export type MemoryFiles = ReturnType<typeof createMemoryFiles>
