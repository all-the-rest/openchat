/**
 * The push layer: a compact, deterministic Markdown index of active facts.
 * Only `active`, unexpired facts reach it; superseded, expired and deleted facts
 * stay in the file and are reachable through `mem_get`. Lines are never cut in
 * the middle of a sentence — a line that would pass the token cap is dropped
 * completely, and the next run renders the same way from the same facts.
 */
import { estimateTokens, INDEX_MAX_TOKENS } from "./limits"
import type { MemoryFact, MemoryTrust } from "./types"

const TRUST_RANK: Record<MemoryTrust, number> = { explicit: 3, observed: 2, inferred: 1 }

export function isInjectable(fact: MemoryFact, now: number): boolean {
  if (fact.status !== "active") return false
  const expires = Date.parse(fact.expiresAt)
  return !Number.isFinite(expires) || expires > now
}

function compare(left: MemoryFact, right: MemoryFact): number {
  const trust = TRUST_RANK[right.trust] - TRUST_RANK[left.trust]
  if (trust !== 0) return trust
  const recent = Date.parse(right.lastConfirmedAt) - Date.parse(left.lastConfirmedAt)
  if (recent !== 0) return recent
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt)
  if (created !== 0) return created
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function line(fact: MemoryFact): string {
  const flat = fact.text.replace(/\s+/g, " ").trim()
  return `- ${fact.id} — ${flat} (${fact.trust})`
}

/** Renders the index, capped at `INDEX_MAX_TOKENS` estimated tokens. */
export function renderIndex(facts: readonly MemoryFact[], now: number): string {
  const visible = facts.filter((fact) => isInjectable(fact, now))
  const topics = [...new Set(visible.map((fact) => fact.topic))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const header = "# Memory index\n"
  const lines: string[] = []
  let tokens = estimateTokens(header)
  for (const topic of topics) {
    const heading = `\n## ${topic.replace(/\s+/g, " ").trim()}\n`
    if (tokens + estimateTokens(heading) > INDEX_MAX_TOKENS) break
    let wroteHeading = false
    for (const fact of visible.filter((entry) => entry.topic === topic).sort(compare)) {
      const row = line(fact)
      const extra = estimateTokens(row) + (wroteHeading ? 0 : estimateTokens(heading))
      if (tokens + extra > INDEX_MAX_TOKENS) continue
      if (!wroteHeading) {
        lines.push(heading)
        tokens += estimateTokens(heading)
        wroteHeading = true
      }
      lines.push(`${row}\n`)
      tokens += estimateTokens(row)
    }
  }
  return `${header}${lines.join("")}`
}
