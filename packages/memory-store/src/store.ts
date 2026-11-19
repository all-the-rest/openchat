/**
 * File-first memory store. `facts.jsonl` is the source of truth; one write
 * appends or atomically replaces it, never rewrites it in place. A lock file
 * serialises mutations across the BFF and the MCP tool processes. Reads tolerate
 * a missing or malformed line, and every mutation appends an audit row and
 * regenerates the bounded `INDEX.md`.
 */
import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises"
import { renderIndex } from "./index-render"
import {
  LOCK_RETRIES,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  MAX_AUDIT_TAIL,
  MAX_FACTS,
  MAX_GET_IDS,
  MAX_TOTAL_BYTES,
  TTL_EXPLICIT_DAYS,
  TTL_INFERRED_DAYS,
  TTL_OBSERVED_DAYS,
} from "./limits"
import {
  auditPath,
  FACTS_FILE,
  factsPath,
  INDEX_FILE,
  indexPath,
  lockPath,
  tempPath,
} from "./paths"
import { planPrune } from "./prune"
import type {
  DeleteOutcome,
  FindOptions,
  FindRow,
  MemoryAuditEntry,
  MemoryExport,
  MemoryFact,
  MemoryStats,
  MemoryTrust,
  PruneOptions,
  PruneResult,
  UpdateOutcome,
  WriteOutcome,
} from "./types"
import { findFacts } from "./find"
import { isDuplicate, validateDraft, validateUpdate } from "./validate"

const DAY_MS = 86_400_000

export interface MemoryStoreOptions {
  /** Directory holding facts.jsonl, INDEX.md, audit.jsonl and .lock. */
  dir: string
  /** Injected clock; defaults to Date.now. */
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFact(value: unknown): value is MemoryFact {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.topic === "string" &&
    Array.isArray(value.tags) &&
    isRecord(value.source) &&
    (value.trust === "explicit" || value.trust === "observed" || value.trust === "inferred") &&
    (value.status === "active" ||
      value.status === "superseded" ||
      value.status === "expired" ||
      value.status === "deleted") &&
    Array.isArray(value.supersedes) &&
    typeof value.createdAt === "string" &&
    typeof value.lastConfirmedAt === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.checksum === "string"
  )
}

function canonical(fact: MemoryFact): string {
  const { checksum: _ignored, ...rest } = fact
  return JSON.stringify(rest)
}

export function checksumOf(fact: MemoryFact): string {
  return createHash("sha256").update(canonical(fact)).digest("hex")
}

export function ttl(trust: MemoryTrust, now: number): number {
  const days =
    trust === "explicit" ? TTL_EXPLICIT_DAYS : trust === "observed" ? TTL_OBSERVED_DAYS : TTL_INFERRED_DAYS
  return now + days * DAY_MS
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class MemoryStoreBase {
  protected readonly dir: string
  protected readonly now: () => number

  constructor(options: MemoryStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? (() => Date.now())
  }

  protected async acquire(): Promise<() => Promise<void>> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
    const path = lockPath(this.dir)
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await handle.writeFile(String(process.pid))
        await handle.close()
        return async () => {
          await unlink(path).catch(() => undefined)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        try {
          const info = await stat(path)
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(path).catch(() => undefined)
        } catch {
          // The holder released between the failed open and the stat.
        }
        await delay(LOCK_RETRY_MS)
      }
    }
    throw new Error("memory: lock is busy")
  }

  protected async withLock<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await task()
    } finally {
      await release()
    }
  }

  protected async readFacts(): Promise<MemoryFact[]> {
    const path = factsPath(this.dir)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) return []
    } catch {
      return []
    }
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      return []
    }
    const facts: MemoryFact[] = []
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isFact(parsed)) facts.push(parsed)
      } catch {
        // One corrupt line is skipped; the rest of the store stays readable.
      }
    }
    return facts
  }

  protected async atomicWrite(name: string, payload: string): Promise<void> {
    const temporary = tempPath(this.dir, name, randomBytes(6).toString("hex"))
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(payload)
    } finally {
      await handle.close()
    }
    await chmod(temporary, 0o600)
    await rename(temporary, name === FACTS_FILE ? factsPath(this.dir) : indexPath(this.dir))
  }

  protected async saveFacts(facts: readonly MemoryFact[]): Promise<void> {
    const payload = facts.map((fact) => JSON.stringify(fact)).join("\n")
    await this.atomicWrite(FACTS_FILE, `${payload}${payload.length > 0 ? "\n" : ""}`)
  }

  protected async appendAudit(rows: readonly MemoryAuditEntry[]): Promise<void> {
    if (rows.length === 0) return
    const handle = await open(auditPath(this.dir), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
    } finally {
      await handle.close()
    }
  }

  protected audit(action: MemoryAuditEntry["action"], ids: string[], reason: string, actor: string): MemoryAuditEntry {
    return { at: new Date(this.now()).toISOString(), actor, action, ids: [...ids], reason }
  }

  protected async refresh(facts: readonly MemoryFact[]): Promise<void> {
    await this.saveFacts(facts)
    await this.atomicWrite(INDEX_FILE, renderIndex(facts, this.now()))
  }

  /** All facts, newest first; includes every status. */
  async list(): Promise<MemoryFact[]> {
    const facts = await this.readFacts()
    return facts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  /** Full records for chosen ids, or a compact projection when fields are given. */
  async get(ids: readonly string[], fields?: readonly string[]): Promise<Array<Record<string, unknown>>> {
    const wanted = ids.slice(0, MAX_GET_IDS)
    const byId = new Map((await this.readFacts()).map((fact) => [fact.id, fact]))
    const rows: Array<Record<string, unknown>> = []
    for (const id of wanted) {
      const fact = byId.get(id)
      if (!fact) continue
      if (!fields) {
        rows.push({ ...fact })
        continue
      }
      const picked: Record<string, unknown> = {}
      const source = fact as unknown as Record<string, unknown>
      for (const field of fields) if (field in source) picked[field] = source[field]
      rows.push(picked)
    }
    return rows
  }

  async find(options: FindOptions): Promise<FindRow[]> {
    return findFacts(await this.readFacts(), options, this.now())
  }

  async index(): Promise<string> {
    try {
      const info = await lstat(indexPath(this.dir))
      if (info.isFile() && !info.isSymbolicLink()) return await readFile(indexPath(this.dir), "utf8")
    } catch {
      // Fall through to a fresh render from the source of truth.
    }
    return renderIndex(await this.readFacts(), this.now())
  }

  async stats(): Promise<MemoryStats> {
    const facts = await this.readFacts()
    let bytes = 0
    try {
      bytes = (await stat(factsPath(this.dir))).size
    } catch {
      bytes = facts.reduce((sum, fact) => sum + JSON.stringify(fact).length, 0)
    }
    return {
      total: facts.length,
      active: facts.filter((fact) => fact.status === "active").length,
      superseded: facts.filter((fact) => fact.status === "superseded").length,
      expired: facts.filter((fact) => fact.status === "expired").length,
      deleted: facts.filter((fact) => fact.status === "deleted").length,
      bytes,
      topics: new Set(facts.map((fact) => fact.topic)).size,
    }
  }

  async auditTail(limit = MAX_AUDIT_TAIL): Promise<MemoryAuditEntry[]> {
    let text: string
    try {
      text = await readFile(auditPath(this.dir), "utf8")
    } catch {
      return []
    }
    const rows = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line)
          return isRecord(parsed) ? [parsed as unknown as MemoryAuditEntry] : []
        } catch {
          return []
        }
      })
    return rows.slice(-Math.max(0, Math.min(MAX_AUDIT_TAIL, limit))).reverse()
  }

  async export(): Promise<MemoryExport> {
    return { version: 1, exportedAt: new Date(this.now()).toISOString(), facts: await this.list() }
  }
}
