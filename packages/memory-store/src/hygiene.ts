import type { MemoryFact, MemoryStatus } from "@openchat/contracts"

/**
 * Write hygiene and ranking helpers. Memory enters the system context, so a
 * secret or an instruction-shaped payload is rejected at the boundary instead
 * of being stored and replayed. Codes are stable and never echo the text.
 */

export type MemoryErrorCode =
  | "memory_secret_rejected"
  | "memory_instruction_rejected"
  | "memory_duplicate"
  | "memory_invalid"
  | "memory_too_large"
  | "memory_store_full"
  | "memory_not_found"

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{4,}/i,
]

const INSTRUCTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bignore\s+(?:all\s+)?(?:the\s+)?previous\b/i,
  /\bdisregard\s+(?:all\s+)?(?:the\s+)?previous\b/i,
  /(?:^|\n)\s*system\s*:/i,
  /<\|?system\|?>/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
]

export function checkFactText(text: string): MemoryErrorCode | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return "memory_secret_rejected"
  }
  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(text)) return "memory_instruction_rejected"
  }
  return null
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "in", "is", "it", "its", "of", "on", "or", "that", "the",
  "their", "to", "was", "were", "with",
])

/** Lowercase word tokens; punctuation and whitespace are separators. */
export function tokensFor(value: string): string[] {
  const matches = value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
  return matches.filter((token) => !STOPWORDS.has(token))
}

/** Lowercase, punctuation-free form used for exact duplicate detection. */
export function normalizeText(value: string): string {
  return tokensFor(value).join(" ")
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * Near-identical means the same topic and a token overlap of 0.8, or an
 * overlap of 0.95 even across topics: ten paraphrases of one fact must not
 * accumulate, while a genuinely different fact on the same topic may.
 */
export function isNearDuplicate(
  text: string,
  topic: string,
  other: { text: string; topic: string },
): boolean {
  const normalized = normalizeText(text)
  if (normalized.length > 0 && normalized === normalizeText(other.text)) {
    return topic === other.topic || normalized.length >= 12
  }
  const similarity = jaccard(new Set(tokensFor(text)), new Set(tokensFor(other.text)))
  if (similarity >= 0.95) return true
  return topic === other.topic && similarity >= 0.8
}

export function trustRank(trust: MemoryFact["trust"]): number {
  if (trust === "explicit") return 3
  if (trust === "observed") return 2
  return 1
}

/** Expiry is evaluated on read too, so an unpruned fact cannot linger. */
export function effectiveStatus(fact: MemoryFact, nowMs: number): MemoryStatus {
  if (fact.status !== "active") return fact.status
  if (fact.expiresAt !== null && Date.parse(fact.expiresAt) <= nowMs) return "expired"
  return "active"
}

export function defaultExpiry(trust: MemoryFact["trust"], now: Date): string {
  const days = trust === "explicit" ? 365 : 90
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}
