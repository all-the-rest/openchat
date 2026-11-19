/** Candidate ranking for `mem_prune`. Dry-run and apply use the same plan. */
import { MAX_FACT_BYTES } from "./limits"
import { similarity } from "./validate"
import type { MemoryFact, PruneCandidate, PruneOptions } from "./types"

const DAY_MS = 86_400_000

function ageDays(fact: MemoryFact, now: number): number {
  const created = Date.parse(fact.createdAt)
  return Number.isFinite(created) ? Math.floor((now - created) / DAY_MS) : 0
}

/**
 * Ranks shrink candidates with a reason for each. Stale uses the caller's
 * `maxAgeDays` (or the fact's own `expiresAt`); superseded, duplicate and
 * oversized need no option. The list is deterministic: reason, then age, then
 * id, so a dry run previews exactly what apply will remove.
 */
export function planPrune(
  facts: readonly MemoryFact[],
  options: PruneOptions,
  now: number,
): PruneCandidate[] {
  const maxAge = options.maxAgeDays
  const candidates: PruneCandidate[] = []
  for (const fact of facts) {
    const age = ageDays(fact, now)
    if (fact.status === "superseded" && options.superseded !== false) {
      candidates.push({ id: fact.id, reason: "superseded", text: fact.text, topic: fact.topic, ageDays: age })
      continue
    }
    if (fact.status === "deleted") continue
    if (Buffer.byteLength(JSON.stringify(fact), "utf8") > (options.maxBytes ?? MAX_FACT_BYTES)) {
      candidates.push({ id: fact.id, reason: "oversized", text: fact.text, topic: fact.topic, ageDays: age })
      continue
    }
    const expired = Date.parse(fact.expiresAt)
    const stale = (Number.isFinite(expired) && expired <= now) || (maxAge !== undefined && age >= maxAge)
    if (stale && fact.status === "active") {
      candidates.push({ id: fact.id, reason: "stale", text: fact.text, topic: fact.topic, ageDays: age })
      continue
    }
    if (fact.status === "active") {
      const twin = facts.find(
        (other) =>
          other.id !== fact.id &&
          other.status === "active" &&
          other.topic === fact.topic &&
          similarity(other.text, fact.text) >= 0.9,
      )
      if (twin && twin.id < fact.id) {
        candidates.push({ id: fact.id, reason: "duplicate", text: fact.text, topic: fact.topic, ageDays: age })
      }
    }
  }
  const order: Record<PruneCandidate["reason"], number> = {
    stale: 0,
    superseded: 1,
    duplicate: 2,
    oversized: 3,
  }
  candidates.sort((a, b) =>
    order[a.reason] - order[b.reason] || b.ageDays - a.ageDays || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return candidates
}
