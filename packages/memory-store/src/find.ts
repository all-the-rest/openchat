/**
 * Pull layer: a small BM25-ish keyword scorer over text, tags and topic. It is
 * deliberately local and dependency-free: one owner's store does not need an
 * embedding service, and substring/keyword search finds operational facts that
 * semantic search misses. Recency and trust only break score ties.
 */
import { MAX_FIND_ROWS } from "./limits"
import { isInjectable } from "./index-render"
import { wordBag } from "./validate"
import type { FindOptions, FindRow, MemoryFact, MemoryTrust } from "./types"

const TRUST_RANK: Record<MemoryTrust, number> = { explicit: 3, observed: 2, inferred: 1 }

function termScore(fact: MemoryFact, tokens: readonly string[]): number {
  const text = fact.text.toLowerCase()
  const topic = fact.topic.toLowerCase()
  const tags = fact.tags.map((tag) => tag.toLowerCase())
  let score = 0
  for (const token of tokens) {
    let count = 0
    for (const part of text.split(/\W+/)) if (part === token) count += 1
    if (count > 0) score += 1 + Math.log(count)
    if (topic.split(/\W+/).includes(token)) score += 3
    if (tags.includes(token)) score += 2
    // Substring catch for partial words, weighted below an exact token.
    if (count === 0 && text.includes(token)) score += 0.5
  }
  return score
}

function project(fact: MemoryFact, score: number, fields?: readonly string[]): FindRow {
  const row: FindRow = {
    id: fact.id,
    text: fact.text,
    topic: fact.topic,
    tags: fact.tags,
    trust: fact.trust,
    createdAt: fact.createdAt,
    lastConfirmedAt: fact.lastConfirmedAt,
    score: Math.round(score * 100) / 100,
  }
  if (!fields) return row
  const picked: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in row) picked[field] = row[field as keyof FindRow]
  }
  return picked as unknown as FindRow
}

/** Active, unexpired facts matching the queries, ranked best first. */
export function findFacts(
  facts: readonly MemoryFact[],
  options: FindOptions,
  now: number,
): FindRow[] {
  const tokens = options.queries
    .flatMap((query) => [...wordBag(query)])
    .filter((token) => token.length > 1)
  const since = options.since ? Date.parse(options.since) : Number.NaN
  const tags = (options.tags ?? []).map((tag) => tag.toLowerCase())
  const filtered = facts.filter((fact) => {
    if (!isInjectable(fact, now)) return false
    if (tags.length > 0 && !tags.every((tag) => fact.tags.includes(tag))) return false
    if (Number.isFinite(since) && Date.parse(fact.lastConfirmedAt) < since) return false
    return true
  })
  const scored = filtered.map((fact) => ({ fact, score: termScore(fact, tokens) }))
  const relevant = tokens.length > 0 ? scored.filter((entry) => entry.score > 0) : scored
  relevant.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    const trust = TRUST_RANK[right.fact.trust] - TRUST_RANK[left.fact.trust]
    if (trust !== 0) return trust
    const recent = Date.parse(right.fact.lastConfirmedAt) - Date.parse(left.fact.lastConfirmedAt)
    if (recent !== 0) return recent
    return left.fact.id < right.fact.id ? -1 : left.fact.id > right.fact.id ? 1 : 0
  })
  const rawLimit = options.limit ?? MAX_FIND_ROWS
  const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(MAX_FIND_ROWS, rawLimit)) : MAX_FIND_ROWS
  return relevant.slice(0, limit).map((entry) => project(entry.fact, entry.score, options.fields))
}
