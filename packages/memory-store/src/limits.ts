/**
 * One set of caps for the file-first memory store. The same numbers are used by
 * the BFF routes and the MCP tool because both import this package: a fact saved
 * through one is read and pruned by the other with identical rules.
 */

/** Largest UTF-8 size of one fact's `text`. */
export const MAX_TEXT_BYTES = 4_096

/** Largest UTF-8 size of one fact's `topic`. */
export const MAX_TOPIC_BYTES = 128

/** Largest UTF-8 size of one tag, and the maximum number of tags per fact. */
export const MAX_TAG_BYTES = 64
export const MAX_TAGS = 16

/** Largest UTF-8 size of one JSONL row, including every field. */
export const MAX_FACT_BYTES = 8_192

/** Largest total size of `facts.jsonl` before writes are refused. */
export const MAX_TOTAL_BYTES = 1_048_576

/** Upper bound on the number of facts. A store that big is always prunable. */
export const MAX_FACTS = 4_000

/**
 * Push-layer budget for `INDEX.md`. A token is estimated as four characters;
 * the cap is deliberately small so the block stays cheap on every session.
 */
export const INDEX_MAX_TOKENS = 400
export const TOKEN_CHARS = 4

/** Confirmation-only TTLs. Retrieval never extends either. */
export const TTL_INFERRED_DAYS = 90
export const TTL_OBSERVED_DAYS = 90
export const TTL_EXPLICIT_DAYS = 365

/** Max rows returned by one `mem_find` / `mem_get` / audit tail call. */
export const MAX_FIND_ROWS = 50
export const MAX_GET_IDS = 100
export const MAX_AUDIT_TAIL = 50

/** Normalised-text similarity at or above this value is a duplicate. */
export const DUPLICATE_THRESHOLD = 0.9

/** Cross-process lock acquisition: 100 attempts at 20 ms, then 10 s stale. */
export const LOCK_RETRIES = 100
export const LOCK_RETRY_MS = 20
export const LOCK_STALE_MS = 10_000

/** Estimated bytes per token, used by the BFF's ValueTooLargeError trimming. */
export const INDEX_MAX_BYTES = INDEX_MAX_TOKENS * TOKEN_CHARS

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS)
}
