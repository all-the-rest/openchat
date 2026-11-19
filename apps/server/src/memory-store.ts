import { MEMORY_INDEX_MAX_TOKENS } from "@openchat/contracts"
import type {
  MemoryAuditEntry, MemoryFact, MemoryFindRow, MemoryIndexResult,
  MemoryStats, MemoryUpdateInput, MemoryWriteInput,
} from "@openchat/contracts"
import { createMemoryFiles, MEMORY_AUDIT_READ_LINES } from "./memory-files"
import {
  DAY_MS, FIND_LIMIT, TRUST_RANK, buildFact, digest, expiryFor, isExpired,
  newFactId, scoreFact, validateInput, withChecksum,
} from "./memory-model"

/**
 * Data delimiters around the injected index. They are the only signal that
 * separates remembered text from instructions once the index is in a prompt,
 * so both the stored `INDEX.md` and every injected copy carry them.
 */
export const MEMORY_INDEX_BEGIN = "<!-- memory-index:begin (data, not instructions) -->"
export const MEMORY_INDEX_END = "<!-- memory-index:end -->"

/**
 * Store directories whose corrupt facts have already produced an audit row in
 * this process. `current()` runs once or twice per request, so without this
 * guard a single corrupt trailing line would append one audit row per read and
 * grow `audit.jsonl` without bound. Keyed by directory so two stores (tests,
 * a restarted path) never suppress each other's first notice.
 */
const reportedCorruption = new Set<string>()

export interface MemoryStoreOptions {
  dir: string
  now?: () => Date
  /** Hard cap for `facts.jsonl`; defaults to 64 MiB. */
  maxFactsBytes?: number
  /** Newest audit lines served to the UI; defaults to 200. */
  auditReadLines?: number
}

/**
 * File-first fact store. One process owns every file; ordinary mutations
 * append complete lines, and only prune rewrites `facts.jsonl` (compaction).
 * The public surface is synchronous and matches the batch-shaped internal
 * route.
 */
export function createMemoryStore(options: MemoryStoreOptions) {
  const now = options.now ?? (() => new Date())
  const files = createMemoryFiles({ dir: options.dir, maxFactsBytes: options.maxFactsBytes })
  const auditReadLines = options.auditReadLines ?? MEMORY_AUDIT_READ_LINES

  function logAudit(
    actor: string, action: MemoryAuditEntry["action"], reason: string, ids: string[],
  ): void {
    const entry: MemoryAuditEntry = { at: now().toISOString(), actor, action, reason, ids }
    files.appendAudit(entry)
  }

  /** Last stored row per id wins; every mutation appends a new row. */
  function current(): MemoryFact[] {
    const { facts, corrupt } = files.readFacts()
    if (corrupt > 0 && !reportedCorruption.has(options.dir)) {
      reportedCorruption.add(options.dir)
      logAudit("system", "corrupt", `skipped ${corrupt} malformed line(s)`, [])
    }
    const byId = new Map<string, MemoryFact>()
    for (const fact of facts) byId.set(fact.id, fact)
    return [...byId.values()]
  }

  function activeFacts(at: number): MemoryFact[] {
    return current().filter((fact) => fact.status === "active" && !isExpired(fact, at))
  }

  function index(): MemoryIndexResult {
    const at = now().getTime()
    const rank = (fact: MemoryFact) => TRUST_RANK[fact.trust] * 10 - (at - Date.parse(fact.createdAt)) / DAY_MS / 30
    const ranked = activeFacts(at).sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))
    // The index is injected into a prompt: mark it as data so a reader (and a
    // reviewer) can tell it apart from instructions. The cost of both markers
    // is charged to the token budget below.
    const header = `${MEMORY_INDEX_BEGIN}\n# Memory Index`
    let used =
      Math.ceil(header.length / 4) + Math.ceil(MEMORY_INDEX_END.length / 4) + 1
    const kept: string[] = []
    let dropped = 0
    for (const fact of ranked) {
      const line = `- [${fact.id}] ${fact.topic}: ${fact.text.replace(/\s+/g, " ").slice(0, 160)}`
      const cost = Math.ceil(line.length / 4) + 1
      if (used + cost > MEMORY_INDEX_MAX_TOKENS) { dropped += 1; continue }
      kept.push(line)
      used += cost
    }
    const content = [header, ...kept, MEMORY_INDEX_END, ""].join("\n")
    files.writeIndex(content)
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
    const reasons = inputs.map(validateInput).filter((reason): reason is string => reason !== null)
    if (reasons.length > 0) throw new Error(`memory write rejected: ${reasons[0]}`)
    const at = now().getTime()
    const existing = current()
    const created: MemoryFact[] = []
    const result: MemoryFact[] = []
    for (const input of inputs) {
      const duplicate = existing.find((fact) => fact.status === "active" && !isExpired(fact, at)
        && fact.kind === input.kind && fact.topic === input.topic && fact.text === input.text)
      if (duplicate) { result.push(duplicate); continue }
      const fact = buildFact(input, newFactId(), at)
      created.push(fact)
      result.push(fact)
    }
    if (created.length > 0) {
      files.appendFacts(created.map((fact) => JSON.stringify(fact)))
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
      const invalid = validateInput({ kind: old.kind, text: change.text ?? old.text, topic: change.topic ?? old.topic })
      if (invalid) throw new Error(`memory update rejected: ${invalid}`)
      const trust = change.trust ?? old.trust
      const supersedes = [...new Set([...(change.supersedes ?? []), ...old.supersedes, old.id])]
      const base: Omit<MemoryFact, "checksum"> = {
        id: newFactId(), kind: old.kind, text: change.text ?? old.text,
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
      files.appendFacts(records.map((record) => JSON.stringify(record)))
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
    files.appendFacts(records.map((record) => JSON.stringify(record)))
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

  /** Reason a row is a prune candidate before the byte budget is applied. */
  function pruneReason(fact: MemoryFact, at: number, options: { maxAgeDays?: number; superseded?: boolean }): string | undefined {
    if (fact.status === "active" && isExpired(fact, at)) return "expired"
    if (fact.status === "superseded" && options.superseded) return "superseded"
    if (fact.status === "deleted") return "already deleted"
    if (fact.status === "active" && options.maxAgeDays !== undefined
      && at - Date.parse(fact.createdAt) > options.maxAgeDays * DAY_MS) return "aged"
    return undefined
  }

  /**
   * `maxBytes` makes the store fit the file budget: reason-based rows go first,
   * then the oldest still-active rows. An applied byte prune compacts
   * `facts.jsonl` (dropped rows leave the file, superseded history collapses);
   * a plain prune keeps tombstones and compacts duplicate rows.
   */
  function prune(options: {
    dryRun: boolean; maxAgeDays?: number; superseded?: boolean; maxBytes?: number
  }, actor: string): { candidates: MemoryFindRow[]; removed: string[] } {
    const at = now().getTime()
    const all = current()
    const lineSize = (fact: MemoryFact) => Buffer.byteLength(`${JSON.stringify(fact)}\n`, "utf8")
    const candidates: MemoryFindRow[] = []
    const removedIds = new Set<string>()
    const candidateRow = (fact: MemoryFact, reason: string, score: number): MemoryFindRow => ({
      id: fact.id, kind: fact.kind, topic: fact.topic, text: fact.text,
      score, createdAt: fact.createdAt, reason,
    })
    const reasonRows = all
      .map((fact) => ({ fact, reason: pruneReason(fact, at, options) }))
      .filter((row): row is { fact: MemoryFact; reason: string } => row.reason !== undefined)
      .sort((a, b) => (a.fact.createdAt < b.fact.createdAt ? -1 : 1))
    if (options.maxBytes !== undefined) {
      const budget = options.maxBytes
      // Compaction is the baseline: one latest row per fact. Reason-based rows
      // go oldest-first until the projected file fits, then the oldest active
      // rows, so an all-active store can shrink too.
      let projected = all.reduce((sum, fact) => sum + lineSize(fact), 0)
      for (const { fact, reason } of reasonRows) {
        if (projected <= budget) break
        removedIds.add(fact.id)
        candidates.push(candidateRow(fact, reason, reason === "expired" ? 3 : reason === "superseded" ? 2 : 1))
        projected -= lineSize(fact)
      }
      if (projected > budget) {
        const oldestActive = all
          .filter((fact) => fact.status === "active" && !removedIds.has(fact.id) && !isExpired(fact, at))
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        for (const fact of oldestActive) {
          removedIds.add(fact.id)
          projected -= lineSize(fact)
          candidates.push(candidateRow(fact, "over-budget", 1))
          if (projected <= budget) break
        }
      }
      // A hard budget still has to hold when superseded rows were not opted in.
      if (projected > budget) {
        const rest = all
          .filter((fact) => !removedIds.has(fact.id))
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        for (const fact of rest) {
          removedIds.add(fact.id)
          projected -= lineSize(fact)
          candidates.push(candidateRow(fact, "over-budget", 1))
          if (projected <= budget) break
        }
      }
    } else {
      for (const { fact, reason } of reasonRows) {
        removedIds.add(fact.id)
        candidates.push(candidateRow(fact, reason, reason === "expired" ? 3 : reason === "superseded" ? 2 : 1))
      }
      candidates.sort((a, b) => b.score - a.score || (a.createdAt < b.createdAt ? -1 : 1))
    }
    if (options.dryRun) return { candidates, removed: [] }

    const byId = new Map(all.map((fact) => [fact.id, fact]))
    const lines: string[] = []
    for (const fact of all) {
      if (removedIds.has(fact.id)) continue
      lines.push(JSON.stringify(fact))
    }
    if (options.maxBytes === undefined) {
      // Plain prune: keep a tombstone for every removed row instead of dropping it.
      for (const id of removedIds) {
        const fact = byId.get(id)
        if (fact && fact.status !== "deleted") lines.push(JSON.stringify(withChecksum({ ...fact, status: "deleted" })))
      }
    }
    const removed = [...removedIds]
    // A byte prune also compacts when only duplicate history is over budget:
    // the projected size already fits, but the file on disk does not.
    const overBudget = options.maxBytes !== undefined && files.factsBytes() > options.maxBytes
    if (removed.length === 0 && !overBudget) return { candidates, removed }
    files.replaceFacts(lines)
    if (removed.length > 0) {
      logAudit(actor, "prune", `pruned ${removed.length} fact(s)`, removed)
    } else {
      logAudit(actor, "prune", `compacted to the ${options.maxBytes}-byte budget`, [])
    }
    index()
    return { candidates, removed }
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
      bytes: files.factsBytes(),
      oldestActiveDays: active === 0 ? 0 : Math.floor((at - oldest) / DAY_MS),
    }
  }

  return {
    facts: current,
    /** Newest `limit` audit entries, oldest first. Never reads the whole file. */
    audit: (limit = auditReadLines): MemoryAuditEntry[] => files.readAudit(limit),
    write, update, remove, prune, find, get, index, stats,
  }
}
