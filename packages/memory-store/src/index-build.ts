import type { MemoryFact } from "@openchat/contracts"
import { effectiveStatus, trustRank } from "./hygiene"

/**
 * The push layer: a deterministic, ranked index of active facts. It is written
 * after every mutation and injected into each session, so it is capped by
 * characters (about 400 tokens) and never contains a timestamp that would make
 * an unchanged store produce different bytes.
 */

export const INDEX_MAX_CHARS = 1_600

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

export function rankFacts(facts: readonly MemoryFact[], nowMs: number): MemoryFact[] {
  return facts
    .filter((fact) => effectiveStatus(fact, nowMs) === "active")
    .slice()
    .sort((left, right) => {
      const rank = trustRank(right.trust) - trustRank(left.trust)
      if (rank !== 0) return rank
      if (left.lastConfirmedAt !== right.lastConfirmedAt) {
        return left.lastConfirmedAt < right.lastConfirmedAt ? 1 : -1
      }
      return left.id.localeCompare(right.id)
    })
}

export interface IndexBuild {
  text: string
  chars: number
  tokens: number
  included: number
  omitted: number
}

export function buildIndex(
  facts: readonly MemoryFact[],
  nowMs: number,
  maxChars = INDEX_MAX_CHARS,
): IndexBuild {
  const ranked = rankFacts(facts, nowMs)
  const header = [
    "# Memory index",
    "<!-- generated from facts.jsonl; edit the store, not this file -->",
  ].join("\n")
  const lines: string[] = [header]
  let chars = header.length + 1
  let included = 0

  for (const fact of ranked) {
    const line = `- [${oneLine(fact.topic)}] ${oneLine(fact.text)} (${fact.id}, ${fact.trust})`
    // One reserved line for the omission marker keeps the cap truthful.
    if (chars + line.length + 1 > maxChars - 60) break
    lines.push(line)
    chars += line.length + 1
    included += 1
  }

  const omitted = ranked.length - included
  if (omitted > 0) {
    lines.push(`<!-- ${omitted} more active facts; use mem_find -->`)
  }
  const text = `${lines.join("\n")}\n`
  return {
    text,
    chars: text.length,
    tokens: estimateTokens(text.length),
    included,
    omitted,
  }
}
