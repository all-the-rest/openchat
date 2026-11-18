import { randomBytes } from "node:crypto"
import { join } from "node:path"
import type { MemoryFact, MemoryStats } from "@openchat/contracts"
import {
  AUDIT_FILE,
  FACTS_FILE,
  INDEX_FILE,
  appendLine,
  encodeJsonl,
  ensureMemoryDir,
  parseJsonl,
  readRegularFile,
  withMemoryLock,
  writeAtomic,
} from "./io"
import { checkFactText, defaultExpiry, effectiveStatus, isNearDuplicate } from "./hygiene"
import { INDEX_MAX_CHARS, buildIndex, estimateTokens } from "./index-build"
import { factChecksum, factTitle, isRecord, isStoredFact, iso, rehash } from "./fact"
import { pruneCandidates } from "./prune"
import { searchFacts } from "./search"
import type {
  MemoryAuditEntry,
  MemoryItemResult,
  MemoryUpdateEntry,
  MemoryWriteEntry,
  PruneOptions,
  PruneResult,
} from "./types"

export interface MemoryStoreOptions {
  dir: string
  /** Injected clock; tests advance it. */
  now?: () => Date
  maxEntryBytes?: number
  maxTotalBytes?: number
  indexMaxChars?: number
}

const DEFAULT_ENTRY_BYTES = 8_192
const DEFAULT_TOTAL_BYTES = 524_288

export class MemoryStore {
  readonly dir: string
  private readonly now: () => Date
  private readonly maxEntryBytes: number
  private readonly maxTotalBytes: number
  private readonly indexMaxChars: number

  constructor(options: MemoryStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? (() => new Date())
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_ENTRY_BYTES
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TOTAL_BYTES
    this.indexMaxChars = options.indexMaxChars ?? INDEX_MAX_CHARS
  }

  private path(name: string): string {
    return join(this.dir, name)
  }

  private exceedsTotal(facts: readonly MemoryFact[]): boolean {
    return Buffer.byteLength(encodeJsonl(facts), "utf8") > this.maxTotalBytes
  }

  /** Every intact line, including deleted rows; corrupt lines are skipped. */
  async facts(): Promise<MemoryFact[]> {
    const text = await readRegularFile(this.path(FACTS_FILE))
    return text === null ? [] : parseJsonl(text, isStoredFact)
  }

  /** What the owner sees: everything except a soft-deleted row. */
  async list(): Promise<MemoryFact[]> {
    const facts = (await this.facts()).filter((fact) => fact.status !== "deleted")
    return facts.sort((left, right) => {
      if (left.topic !== right.topic) return left.topic.localeCompare(right.topic)
      return left.id.localeCompare(right.id)
    })
  }

  async get(ids: readonly string[]): Promise<MemoryFact[]> {
    const wanted = new Set(ids)
    return (await this.facts()).filter((fact) => wanted.has(fact.id))
  }

  async readIndex(): Promise<string> {
    const stored = await readRegularFile(this.path(INDEX_FILE))
    if (stored !== null) return stored
    const built = buildIndex(await this.facts(), this.now().getTime(), this.indexMaxChars)
    await ensureMemoryDir(this.dir)
    await writeAtomic(this.path(INDEX_FILE), built.text)
    return built.text
  }

  async audit(limit = 50): Promise<MemoryAuditEntry[]> {
    const text = await readRegularFile(this.path(AUDIT_FILE))
    const rows = text === null
      ? []
      : parseJsonl(text, (value): value is MemoryAuditEntry => {
          if (!isRecord(value)) return false
          return (
            typeof value.at === "string" &&
            typeof value.actor === "string" &&
            typeof value.action === "string" &&
            Array.isArray(value.ids) &&
            typeof value.reason === "string"
          )
        })
    const capped = Math.min(Math.max(Math.trunc(limit), 0), 200)
    return capped === 0 ? [] : rows.slice(-capped)
  }

  async write(entries: readonly MemoryWriteEntry[], actor = "agent"): Promise<MemoryItemResult[]> {
    return this.mutate(async (facts) => {
      const now = this.now()
      const at = iso(now)
      const results: MemoryItemResult[] = []
      for (const entry of entries) {
        const validated = this.validateEntry(entry, facts, now)
        if (!validated.ok) {
          results.push(validated)
          await this.record(actor, "write", [], validated.code)
          continue
        }
        const fact = validated.fact
        const superseded = new Set(fact.supersedes)
        const next = facts.map((current) =>
          superseded.has(current.id) ? rehash({ ...current, status: "superseded" }) : current,
        )
        if (Buffer.byteLength(encodeJsonl([...next, fact]), "utf8") > this.maxTotalBytes) {
          results.push({ ok: false, code: "memory_store_full" })
          await this.record(actor, "write", [], "memory_store_full")
          continue
        }
        facts.splice(0, facts.length, ...next, fact)
        results.push({ ok: true, fact })
        await this.record(actor, "write", [fact.id], `${fact.topic}: ${factTitle(fact)}`)
      }
      return results
    })
  }

  async update(updates: readonly MemoryUpdateEntry[], actor = "owner"): Promise<MemoryItemResult[]> {
    return this.mutate(async (facts) => {
      const now = this.now()
      const results: MemoryItemResult[] = []
      for (const update of updates) {
        const index = facts.findIndex((fact) => fact.id === update.id)
        const current = index >= 0 ? facts[index] : undefined
        if (!current) {
          results.push({ ok: false, id: update.id, code: "memory_not_found" })
          await this.record(actor, "update", [update.id], "memory_not_found")
          continue
        }
        const next: MemoryFact = {
          ...current,
          text: update.text?.trim() ?? current.text,
          topic: update.topic?.trim() ?? current.topic,
          tags: update.tags ?? current.tags,
          trust: update.trust ?? current.trust,
          status: update.status ?? current.status,
          expiresAt: update.expiresAt === undefined ? current.expiresAt : update.expiresAt,
        }
        const hygiene = checkFactText(next.text)
        if (hygiene) {
          results.push({ ok: false, id: update.id, code: hygiene })
          await this.record(actor, "update", [update.id], hygiene)
          continue
        }
        const duplicate = facts.find(
          (fact) =>
            fact.id !== update.id &&
            effectiveStatus(fact, now.getTime()) === "active" &&
            isNearDuplicate(next.text, next.topic, fact),
        )
        if (duplicate) {
          results.push({ ok: false, id: update.id, code: "memory_duplicate", duplicateOf: duplicate.id })
          await this.record(actor, "update", [update.id], "memory_duplicate")
          continue
        }
        const textChanged = next.text !== current.text
        if (textChanged || update.confirm === true) next.lastConfirmedAt = iso(now)
        const fact = rehash(next)
        if (this.exceedsTotal(facts.map((row, rowIndex) => (rowIndex === index ? fact : row)))) {
          results.push({ ok: false, id: update.id, code: "memory_store_full" })
          await this.record(actor, "update", [update.id], "memory_store_full")
          continue
        }
        facts[index] = fact
        results.push({ ok: true, fact })
        await this.record(actor, "update", [fact.id], `${fact.topic}: ${factTitle(fact)}`)
      }
      return results
    })
  }

  /** Soft delete; a delete is never refused, even for an unknown id. */
  async delete(ids: readonly string[], reason: string, actor = "owner"): Promise<MemoryItemResult[]> {
    return this.mutate(async (facts) => {
      const results: MemoryItemResult[] = []
      for (const id of ids) {
        const index = facts.findIndex((fact) => fact.id === id)
        if (index < 0) {
          results.push({ ok: false, id, code: "memory_not_found" })
          await this.record(actor, "delete", [id], reason)
          continue
        }
        const current = facts[index]
        if (current === undefined) continue
        const fact = rehash({ ...current, status: "deleted" })
        facts[index] = fact
        results.push({ ok: true, fact })
        await this.record(actor, "delete", [id], reason)
      }
      return results
    })
  }

  async prune(options: PruneOptions = {}, actor = "agent"): Promise<PruneResult> {
    const dryRun = options.dryRun !== false
    return this.mutate(async (facts) => {
      const now = this.now()
      const nowMs = now.getTime()
      const candidates = pruneCandidates(facts, nowMs, options, this.maxEntryBytes)
      if (dryRun || candidates.length === 0) return { dryRun, candidates, deleted: [] }
      const ids = new Set(candidates.map((candidate) => candidate.id))
      for (let index = 0; index < facts.length; index += 1) {
        const current = facts[index]
        if (current !== undefined && ids.has(current.id) && current.status !== "deleted") {
          facts[index] = rehash({ ...current, status: "deleted" })
        }
      }
      for (const candidate of candidates) {
        await this.record(actor, "prune", [candidate.id], `prune:${candidate.reason}`)
      }
      return { dryRun, candidates, deleted: candidates.map((candidate) => candidate.id) }
    })
  }

  async stats(): Promise<MemoryStats> {
    const facts = await this.facts()
    const nowMs = this.now().getTime()
    const counts = { active: 0, superseded: 0, expired: 0, deleted: 0 }
    const topics = new Set<string>()
    for (const fact of facts) {
      const status = effectiveStatus(fact, nowMs)
      counts[status] += 1
      if (status === "active") topics.add(fact.topic)
    }
    const bytes = Buffer.byteLength(encodeJsonl(facts), "utf8")
    const index = await this.readIndex()
    return {
      total: facts.length,
      ...counts,
      bytes,
      totalBytesCap: this.maxTotalBytes,
      entryBytesCap: this.maxEntryBytes,
      topics: [...topics].sort(),
      indexChars: index.length,
      indexTokens: estimateTokens(index.length),
    }
  }

  /** Scored keyword search; deleted/superseded/expired rows never match. */
  async find(
    query: string,
    options: { tags?: readonly string[]; since?: string; limit?: number } = {},
  ): Promise<Array<MemoryFact & { score: number }>> {
    return searchFacts(await this.facts(), query, options, this.now().getTime())
  }

  async export(): Promise<{ version: 1; exportedAt: string; facts: MemoryFact[] }> {
    return {
      version: 1,
      exportedAt: iso(this.now()),
      facts: (await this.facts()).slice(),
    }
  }

  // --- internals -----------------------------------------------------------

  private validateEntry(
    entry: MemoryWriteEntry,
    facts: readonly MemoryFact[],
    now: Date,
  ): MemoryItemResult {
    const text = entry.text?.trim() ?? ""
    const topic = entry.topic?.trim() ?? ""
    const tags = (entry.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0)
    if (text.length === 0 || text.length > 2_000 || topic.length === 0 || topic.length > 80) {
      return { ok: false, code: "memory_invalid" }
    }
    if (Buffer.byteLength(text, "utf8") > this.maxEntryBytes) {
      return { ok: false, code: "memory_too_large" }
    }
    const hygiene = checkFactText(text)
    if (hygiene) return { ok: false, code: hygiene }
    const supersedes = [...new Set(entry.supersedes ?? [])]
    for (const id of supersedes) {
      if (!facts.some((fact) => fact.id === id)) {
        return { ok: false, id, code: "memory_not_found" }
      }
    }
    const duplicate = facts.find(
      (fact) =>
        !supersedes.includes(fact.id) &&
        effectiveStatus(fact, now.getTime()) === "active" &&
        isNearDuplicate(text, topic, fact),
    )
    if (duplicate) {
      return { ok: false, code: "memory_duplicate", duplicateOf: duplicate.id }
    }
    const trust = entry.trust ?? "observed"
    const at = iso(now)
    const base: Omit<MemoryFact, "checksum"> = {
      id: `mem_${randomBytes(9).toString("hex")}`,
      text,
      topic,
      tags: tags.slice(0, 10),
      source: {
        sessionID: entry.source?.sessionID ?? "",
        messageID: entry.source?.messageID ?? "",
        at: entry.source?.at ?? at,
      },
      trust,
      status: "active",
      supersedes,
      createdAt: at,
      lastConfirmedAt: at,
      expiresAt: entry.expiresAt === undefined ? defaultExpiry(trust, now) : entry.expiresAt,
    }
    return { ok: true, fact: { ...base, checksum: factChecksum(base) } }
  }

  /**
   * One locked read-modify-write. The mutation returns its per-item result;
   * the whole fact list is written atomically, then INDEX.md is regenerated.
   */
  private async mutate<T>(
    task: (facts: MemoryFact[]) => Promise<T>,
  ): Promise<T> {
    await ensureMemoryDir(this.dir)
    return withMemoryLock(this.dir, async () => {
      const facts = await this.facts()
      const result = await task(facts)
      const encoded = encodeJsonl(facts)
      if (Buffer.byteLength(encoded, "utf8") > this.maxTotalBytes) {
        throw new Error("memory_store_full")
      }
      await writeAtomic(this.path(FACTS_FILE), encoded)
      const index = buildIndex(facts, this.now().getTime(), this.indexMaxChars)
      await writeAtomic(this.path(INDEX_FILE), index.text)
      return result
    })
  }

  private async record(
    actor: string,
    action: MemoryAuditEntry["action"],
    ids: string[],
    reason: string,
  ): Promise<void> {
    const entry: MemoryAuditEntry = { at: iso(this.now()), actor, action, ids, reason }
    await appendLine(this.path(AUDIT_FILE), JSON.stringify(entry))
  }
}

