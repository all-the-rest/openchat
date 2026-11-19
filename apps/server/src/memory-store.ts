import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { MEMORY_INDEX_MAX_TOKENS, MEMORY_KINDS } from "@openchat/contracts"
import type {
  MemoryAuditEntry, MemoryFact, MemoryFindRow, MemoryIndexResult,
  MemoryStats, MemoryTrust, MemoryUpdateInput, MemoryWriteInput,
} from "@openchat/contracts"

const FACTS_FILE = "facts.jsonl"
const AUDIT_FILE = "audit.jsonl"
const INDEX_FILE = "INDEX.md"
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const DAY_MS = 86_400_000
const TTL_DAYS = 90
const TEXT_MAX_BYTES = 8192
const FIND_LIMIT = 50
const TRUST_RANK: Record<MemoryTrust, number> = { explicit: 3, observed: 2, inferred: 1 }

/** Clean-room write-boundary patterns (§6.9). Memory is data, never directives. */
const BRAND = /\b(chatgpt|openai|claude|gemini|copilot|cursor)\b/i
const REFERENCE_PATH = /references[\/\\]raw[\/\\]|docs[\/\\]reference[\/\\]?/i
const SECRET = /\b(password|passphrase|api[ -]?key|private[ -]?key|bearer|token)\b/i
const INSTRUCTION = /\b(ignore previous|disregard)\b|\bsystem\s*:|\byou are\b/i

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
/** Deterministic, key-sorted JSON so the checksum is independent of field order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
function digest(fact: Omit<MemoryFact, "checksum">): string {
  return createHash("sha256").update(canonical(fact)).digest("hex")
}
function withChecksum(fact: MemoryFact): MemoryFact {
  const rest = { ...fact } as Partial<MemoryFact>
  delete rest.checksum
  return { ...rest, checksum: digest(rest as Omit<MemoryFact, "checksum">) } as MemoryFact
}
function isFact(value: unknown): value is MemoryFact {
  if (!isObject(value)) return false
  const strings = ["id", "kind", "text", "topic", "trust", "status", "createdAt", "lastConfirmedAt", "checksum"]
  return strings.every((key) => typeof value[key] === "string")
    && Array.isArray(value.tags) && isObject(value.source) && Array.isArray(value.supersedes)
}

export interface MemoryStoreOptions {
  dir: string
  now?: () => Date
}

/**
 * File-first fact store. One process owns every file; all writes go through a
 * temp file and rename so no existing line is ever mutated in place. The public
 * surface is synchronous and matches the batch-shaped internal route.
 */
export function createMemoryStore(options: MemoryStoreOptions) {
  const dir = options.dir
  const now = options.now ?? (() => new Date())
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

  function appendLines(path: string, lines: string[]): void {
    if (lines.length === 0) return
    const existing = existsSync(path) ? readFileSync(path, "utf8") : ""
    const joiner = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
    writeAtomic(path, existing + joiner + lines.map((line) => `${line}\n`).join(""))
  }

  function logAudit(actor: string, action: MemoryAuditEntry["action"], reason: string, ids: string[]): void {
    const entry: MemoryAuditEntry = { at: now().toISOString(), actor, action, reason, ids }
    appendLines(auditPath, [JSON.stringify(entry)])
  }

  function readAll(): MemoryFact[] {
    if (!existsSync(factsPath)) return []
    const rows: MemoryFact[] = []
    let corrupt = 0
    for (const line of readFileSync(factsPath, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isFact(parsed)) rows.push(parsed)
        else corrupt += 1
      } catch { corrupt += 1 }
    }
    if (corrupt > 0) logAudit("system", "corrupt", `skipped ${corrupt} malformed line(s)`, [])
    return rows
  }

  /** Last stored row per id wins; every mutation appends a new row. */
  function current(): MemoryFact[] {
    const byId = new Map<string, MemoryFact>()
    for (const fact of readAll()) byId.set(fact.id, fact)
    return [...byId.values()]
  }

  function isExpired(fact: MemoryFact, at: number): boolean {
    return fact.status === "active" && fact.expiresAt !== undefined && Date.parse(fact.expiresAt) <= at
  }

  function activeFacts(at: number): MemoryFact[] {
    return current().filter((fact) => fact.status === "active" && !isExpired(fact, at))
  }

  function expiryFor(trust: MemoryTrust, at: number): string | undefined {
    return trust === "explicit" ? undefined : new Date(at + TTL_DAYS * DAY_MS).toISOString()
  }

  function build(input: MemoryWriteInput, id: string, at: number): MemoryFact {
    const trust = input.trust ?? "inferred"
    const base: Omit<MemoryFact, "checksum"> = {
      id, kind: input.kind, text: input.text, topic: input.topic,
      tags: input.tags ?? [], source: input.source ?? {}, trust,
      status: "active", supersedes: [], createdAt: new Date(at).toISOString(),
      lastConfirmedAt: new Date(at).toISOString(), expiresAt: input.expiresAt ?? expiryFor(trust, at),
    }
    return { ...base, checksum: digest(base) }
  }

  function newId(): string {
    return `mem_${randomUUID().replace(/-/g, "").slice(0, 20)}`
  }

  function validate(input: MemoryWriteInput): string | null {
    if (!isObject(input)) return "input must be an object"
    if (!(MEMORY_KINDS as readonly string[]).includes(String(input.kind))) return "invalid kind"
    if (typeof input.text !== "string" || input.text.trim() === "") return "text must not be empty"
    if (Buffer.byteLength(input.text, "utf8") > TEXT_MAX_BYTES) return "text is oversized"
    if (typeof input.topic !== "string" || input.topic.trim() === "") return "topic must not be empty"
    const text = `${input.topic}\n${input.text}`.toLowerCase()
    if (BRAND.test(text)) return "text contains a reference-product brand name"
    if (REFERENCE_PATH.test(text)) return "text contains a reference path"
    if (SECRET.test(text)) return "text contains a secret-like pattern"
    if (INSTRUCTION.test(text)) return "text contains an instruction-like payload"
    return null
  }

  function scoreFact(fact: MemoryFact, terms: string[], at: number): number {
    let score = 0
    let hits = 0
    for (const term of terms) {
      const count = fact.text.toLowerCase().split(term).length - 1
      let weight = count > 0 ? 1 + Math.log(count) : 0
      if (fact.topic.toLowerCase().includes(term)) weight += 6
      if (fact.tags.some((tag) => tag.toLowerCase().includes(term))) weight += 4
      if (weight > 0) hits += 1
      score += weight
    }
    if (hits === 0) return 0
    const recency = Math.max(0, 1 - (at - Date.parse(fact.createdAt)) / (365 * DAY_MS))
    return score + hits * 0.5 + recency + TRUST_RANK[fact.trust] * 0.1
  }

  function index(): MemoryIndexResult {
    const at = now().getTime()
    const rank = (fact: MemoryFact) => TRUST_RANK[fact.trust] * 10 - (at - Date.parse(fact.createdAt)) / DAY_MS / 30
    const ranked = activeFacts(at).sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))
    const header = "# Memory Index"
    let used = Math.ceil(header.length / 4)
    const kept: string[] = []
    let dropped = 0
    for (const fact of ranked) {
      const line = `- [${fact.id}] ${fact.topic}: ${fact.text.replace(/\s+/g, " ").slice(0, 160)}`
      const cost = Math.ceil(line.length / 4) + 1
      if (used + cost > MEMORY_INDEX_MAX_TOKENS) { dropped += 1; continue }
      kept.push(line)
      used += cost
    }
    const content = [header, ...kept, ""].join("\n")
    writeAtomic(indexPath, content)
    return { index: content, entries: kept.length, dropped }
  }

  function find(query: { queries: string[]; tags?: string[]; since?: string; limit?: number }): MemoryFindRow[] {
    const at = now().getTime()
    const terms = [...new Set((query.queries ?? []).flatMap((q) => String(q).toLowerCase().match(/[a-z0-9_]+/g) ?? []))]
    let facts = activeFacts(at)
    if (query.since) facts = facts.filter((fact) => fact.createdAt >= (query.since as string))
    if (query.tags?.length) {
      const wanted = query.tags.map((tag) => tag.toLowerCase())
      facts = facts.filter((fact) => fact.tags.some((tag) => wanted.includes(tag.toLowerCase())))
    }
    const scored = facts.map((fact) => ({ fact, score: scoreFact(fact, terms, at) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || (a.fact.createdAt < b.fact.createdAt ? 1 : -1) || a.fact.id.localeCompare(b.fact.id))
    const limit = Math.max(1, Math.min(query.limit ?? FIND_LIMIT, 200))
    return scored.slice(0, limit).map(({ fact, score }) => ({
      id: fact.id, kind: fact.kind, topic: fact.topic, text: fact.text,
      score: Math.round(score * 100) / 100, createdAt: fact.createdAt,
    }))
  }

  function write(inputs: MemoryWriteInput[], actor: string): MemoryFact[] {
    if (!Array.isArray(inputs)) throw new Error("memory write rejected: inputs must be an array")
    const reasons = inputs.map(validate).filter((reason): reason is string => reason !== null)
    if (reasons.length > 0) throw new Error(`memory write rejected: ${reasons[0]}`)
    const at = now().getTime()
    const existing = current()
    const created: MemoryFact[] = []
    const result: MemoryFact[] = []
    for (const input of inputs) {
      const duplicate = existing.find((fact) => fact.status === "active" && !isExpired(fact, at)
        && fact.kind === input.kind && fact.topic === input.topic && fact.text === input.text)
      if (duplicate) { result.push(duplicate); continue }
      const fact = build(input, newId(), at)
      created.push(fact)
      result.push(fact)
    }
    if (created.length > 0) {
      appendLines(factsPath, created.map((fact) => JSON.stringify(fact)))
      logAudit(actor, "write", `wrote ${created.length} fact(s); ${inputs.length - created.length} duplicate(s)`, created.map((fact) => fact.id))
      index()
    }
    return result
  }

  function update(updates: MemoryUpdateInput[], actor: string): MemoryFact[] {
    if (!Array.isArray(updates)) throw new Error("memory update rejected: updates must be an array")
    const at = now().getTime()
    const byId = new Map(current().map((fact) => [fact.id, fact]))
    const records: MemoryFact[] = []
    const result: MemoryFact[] = []
    const touched: string[] = []
    for (const change of updates) {
      const old = byId.get(change.id)
      if (!old) continue
      const changed = change.text !== undefined || change.topic !== undefined || change.tags !== undefined
        || change.trust !== undefined || change.status !== undefined
      if (!changed) {
        const next = withChecksum({
          ...old,
          lastConfirmedAt: change.confirm ? new Date(at).toISOString() : old.lastConfirmedAt,
          expiresAt: change.confirm ? expiryFor(old.trust, at) : old.expiresAt,
        })
        records.push(next)
        result.push(next)
        touched.push(next.id)
        continue
      }
      const invalid = validate({ kind: old.kind, text: change.text ?? old.text, topic: change.topic ?? old.topic })
      if (invalid) throw new Error(`memory update rejected: ${invalid}`)
      const trust = change.trust ?? old.trust
      const supersedes = [...new Set([...(change.supersedes ?? []), ...old.supersedes, old.id])]
      const base: Omit<MemoryFact, "checksum"> = {
        id: newId(), kind: old.kind, text: change.text ?? old.text,
        topic: change.topic ?? old.topic, tags: change.tags ?? old.tags,
        source: old.source, trust, status: change.status ?? "active", supersedes,
        createdAt: new Date(at).toISOString(),
        lastConfirmedAt: change.confirm ? new Date(at).toISOString() : old.lastConfirmedAt,
        expiresAt: expiryFor(trust, at),
      }
      const next: MemoryFact = { ...base, checksum: digest(base) }
      const retired = withChecksum({ ...old, status: "superseded" })
      records.push(retired, next)
      result.push(next)
      touched.push(old.id, next.id)
    }
    if (records.length > 0) {
      appendLines(factsPath, records.map((record) => JSON.stringify(record)))
      logAudit(actor, "update", `applied ${updates.length} update(s)`, touched)
      index()
    }
    return result
  }

  function remove(input: { ids: string[]; reason: string }, actor: string): void {
    const byId = new Map(current().map((fact) => [fact.id, fact]))
    const records: MemoryFact[] = []
    for (const id of input.ids) {
      const fact = byId.get(id)
      if (fact && fact.status !== "deleted") records.push(withChecksum({ ...fact, status: "deleted" }))
    }
    if (records.length === 0) return
    appendLines(factsPath, records.map((record) => JSON.stringify(record)))
    logAudit(actor, "delete", input.reason, records.map((record) => record.id))
    index()
  }

  function get(ids: string[], fields?: string[]): MemoryFact[] {
    const wanted = new Set(ids)
    const found = current().filter((fact) => wanted.has(fact.id))
    if (!fields?.length) return found
    const allowed = new Set(fields)
    return found.map((fact) => Object.fromEntries(
      Object.entries(fact).filter(([key]) => allowed.has(key)),
    ) as MemoryFact)
  }

  function prune(options: {
    dryRun: boolean; maxAgeDays?: number; superseded?: boolean; maxBytes?: number
  }, actor: string): { candidates: MemoryFindRow[]; removed: string[] } {
    const at = now().getTime()
    const all = current()
    const candidates: MemoryFindRow[] = []
    for (const fact of all) {
      let reason: string | undefined
      if (fact.status === "active" && isExpired(fact, at)) reason = "expired"
      else if (fact.status === "superseded" && options.superseded) reason = "superseded"
      else if (fact.status === "deleted") reason = "already deleted"
      else if (fact.status === "active" && options.maxAgeDays !== undefined
        && at - Date.parse(fact.createdAt) > options.maxAgeDays * DAY_MS) reason = "aged"
      if (!reason) continue
      candidates.push({
        id: fact.id, kind: fact.kind, topic: fact.topic, text: fact.text,
        score: reason === "expired" ? 3 : reason === "superseded" ? 2 : 1,
        createdAt: fact.createdAt, reason,
      })
    }
    if (options.maxBytes !== undefined) {
      const bytes = existsSync(factsPath) ? statSync(factsPath).size : 0
      let excess = Math.max(0, bytes - options.maxBytes)
      candidates.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      const trimmed: MemoryFindRow[] = []
      for (const candidate of candidates) {
        if (excess <= 0) break
        trimmed.push(candidate)
        excess -= Buffer.byteLength(candidate.text, "utf8") + 80
      }
      candidates.length = 0
      candidates.push(...trimmed)
    } else {
      candidates.sort((a, b) => b.score - a.score || (a.createdAt < b.createdAt ? -1 : 1))
    }
    if (options.dryRun) return { candidates, removed: [] }
    const byId = new Map(all.map((fact) => [fact.id, fact]))
    const records: MemoryFact[] = []
    for (const candidate of candidates) {
      const fact = byId.get(candidate.id)
      if (fact && fact.status !== "deleted") records.push(withChecksum({ ...fact, status: "deleted" }))
    }
    if (records.length > 0) {
      appendLines(factsPath, records.map((record) => JSON.stringify(record)))
      logAudit(actor, "prune", `pruned ${records.length} fact(s)`, records.map((record) => record.id))
      index()
    }
    return { candidates, removed: records.map((record) => record.id) }
  }

  function stats(): MemoryStats {
    const at = now().getTime()
    const all = current()
    let active = 0, superseded = 0, expired = 0, deleted = 0
    let oldest = at
    for (const fact of all) {
      if (fact.status === "superseded") superseded += 1
      else if (fact.status === "deleted") deleted += 1
      else if (fact.status === "expired" || isExpired(fact, at)) expired += 1
      else {
        active += 1
        const created = Date.parse(fact.createdAt)
        if (Number.isFinite(created) && created < oldest) oldest = created
      }
    }
    return {
      facts: all.length, active, superseded, expired, deleted,
      bytes: existsSync(factsPath) ? statSync(factsPath).size : 0,
      oldestActiveDays: active === 0 ? 0 : Math.floor((at - oldest) / DAY_MS),
    }
  }

  return {
    facts: current,
    audit: () => {
      if (!existsSync(auditPath)) return []
      const entries: MemoryAuditEntry[] = []
      for (const line of readFileSync(auditPath, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (isObject(parsed) && typeof parsed.at === "string" && typeof parsed.actor === "string" && typeof parsed.action === "string" && typeof parsed.reason === "string" && Array.isArray(parsed.ids)) entries.push(parsed as unknown as MemoryAuditEntry)
        } catch { /* skip corrupt line */ }
      }
      return entries
    },
    write, update, remove, prune, find, get, index, stats,
  }
}
