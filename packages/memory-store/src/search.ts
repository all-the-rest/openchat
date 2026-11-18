import type { MemoryFact } from "@openchat/contracts"
import { effectiveStatus, tokensFor, trustRank } from "./hygiene"

/**
 * BM25-ish keyword scoring over text, topic and tags, with topic/tag bonuses
 * and recency/trust tie-breaks. Inactive rows never reach this function, so a
 * superseded or expired fact cannot reappear through search.
 */
export function searchFacts(
  facts: readonly MemoryFact[],
  query: string,
  options: { tags?: readonly string[]; since?: string; limit?: number },
  nowMs: number,
): Array<MemoryFact & { score: number }> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
  const active = facts.filter((fact) => effectiveStatus(fact, nowMs) === "active")
  const tagFilter = (options.tags ?? []).map((tag) => tag.toLowerCase())
  const sinceMs = options.since === undefined ? null : Date.parse(options.since)
  const eligible = active.filter((fact) => {
    if (tagFilter.length > 0 && !fact.tags.some((tag) => tagFilter.includes(tag.toLowerCase()))) {
      return false
    }
    return sinceMs === null || Date.parse(fact.lastConfirmedAt) >= sinceMs
  })

  const queryTokens = tokensFor(query)
  const documents = eligible.map((fact) => {
    const tokens = [
      ...tokensFor(fact.text),
      ...tokensFor(fact.topic),
      ...fact.tags.flatMap((tag) => tokensFor(tag)),
    ]
    return { fact, tokens, length: tokens.length }
  })
  const avgLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(documents.length, 1)
  const documentFrequency = new Map<string, number>()
  for (const token of queryTokens) {
    documentFrequency.set(token, documents.filter((doc) => doc.tokens.includes(token)).length)
  }

  const scored = documents.map((doc) => {
    let score = 0
    for (const token of queryTokens) {
      const tf = doc.tokens.filter((value) => value === token).length
      if (tf === 0) continue
      const df = documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (doc.length / Math.max(avgLength, 1)))))
    }
    const topic = doc.fact.topic.toLowerCase()
    const normalizedQuery = query.trim().toLowerCase()
    if (normalizedQuery.length > 0) {
      if (topic === normalizedQuery) score += 4
      else if (topic.split(/[._ -]+/).some((part) => queryTokens.includes(part))) score += 2
    }
    for (const tag of doc.fact.tags) {
      if (queryTokens.includes(tag.toLowerCase())) score += 1.5
    }
    return { ...doc.fact, score }
  })

  return scored
    .filter((fact) => fact.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      if (left.lastConfirmedAt !== right.lastConfirmedAt) {
        return left.lastConfirmedAt < right.lastConfirmedAt ? 1 : -1
      }
      return trustRank(right.trust) - trustRank(left.trust)
    })
    .slice(0, limit)
}
