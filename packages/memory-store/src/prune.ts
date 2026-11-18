import type { MemoryFact } from "@openchat/contracts"
import { effectiveStatus, isNearDuplicate } from "./hygiene"
import { rankFacts } from "./index-build"
import { isOlderThan, textBytes } from "./fact"
import type { PruneCandidate, PruneOptions, PruneReason } from "./types"

/**
 * Cleanup candidates, computed without mutating anything. `mem_prune` shows
 * this list on a dry run and only then applies it; a delete is always a soft
 * status change, never a lost line.
 */
export function pruneCandidates(
  facts: readonly MemoryFact[],
  nowMs: number,
  options: PruneOptions,
  maxEntryBytes: number,
): PruneCandidate[] {
  const candidates: PruneCandidate[] = []
  const seen = new Set<string>()
  const add = (fact: MemoryFact, reason: PruneReason) => {
    if (seen.has(fact.id) || fact.status === "deleted") return
    seen.add(fact.id)
    candidates.push({
      id: fact.id,
      topic: fact.topic,
      reason,
      lastConfirmedAt: fact.lastConfirmedAt,
    })
  }

  const maxAgeMs = options.maxAgeDays === undefined ? null : options.maxAgeDays * 86_400_000
  for (const fact of facts) {
    if (effectiveStatus(fact, nowMs) === "expired") add(fact, "stale")
    else if (maxAgeMs !== null && nowMs - Date.parse(fact.lastConfirmedAt) > maxAgeMs) {
      add(fact, "stale")
    }
    if (fact.status === "superseded" && options.superseded !== false) add(fact, "superseded")
    if (textBytes(fact) > maxEntryBytes) add(fact, "oversized")
  }

  const active = rankFacts(facts, nowMs).reverse()
  for (const fact of active) {
    const duplicate = facts.find(
      (other) =>
        other.id !== fact.id &&
        effectiveStatus(other, nowMs) === "active" &&
        isOlderThan(fact, other) &&
        isNearDuplicate(fact.text, fact.topic, other),
    )
    if (duplicate) add(fact, "duplicate")
  }

  const budget = options.maxBytes
  if (budget !== undefined && budget > 0) {
    let bytes = facts.reduce((sum, fact) => sum + textBytes(fact), 0)
    for (const fact of active) {
      if (bytes <= budget) break
      if (seen.has(fact.id)) continue
      add(fact, "over-budget")
      bytes -= textBytes(fact)
    }
  }
  return candidates
}
