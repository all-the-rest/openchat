/**
 * Pure fallback decisions for one turn. Nothing here reads config or writes
 * state: the BFF records the requested model, and when a turn fails before any
 * assistant text it asks these functions whether one retry on the next chain
 * entry is allowed. The usage ledger supplies the paid-turn count.
 */
import type { FallbackReason, ModelRef, TurnPolicy } from "@openchat/contracts"
import { modelKey } from "@openchat/contracts"

/** The normalized failure fields of `SessionErrorData`, all optional. */
export interface TurnFailure {
  code?: string
  message?: string
  retryable?: boolean
}

/**
 * Message keywords are a last resort for providers that send no stable code.
 * Only this prefix is inspected, so a long prose error cannot smuggle a
 * keyword in from far away and no sentence is interpreted.
 */
const MESSAGE_PATTERN_LIMIT = 200

/** Failure kinds a single retry may follow. */
const RETRYABLE_REASONS: ReadonlySet<FallbackReason> = new Set([
  "rate_limit",
  "provider_error",
  "timeout",
  "context_overflow",
])

const RATE_LIMIT_CODES = new Set([
  "rate_limit",
  "rate_limited",
  "rate_limit_exceeded",
  "ratelimit",
  "too_many_requests",
  "throttled",
  "429",
])

const TIMEOUT_CODES = new Set([
  "timeout",
  "timed_out",
  "gateway_timeout",
  "deadline_exceeded",
  "etimedout",
  "504",
])

const AUTH_CODES = new Set([
  "auth",
  "authentication_error",
  "unauthorized",
  "invalid_api_key",
  "forbidden",
  "permission_denied",
  "401",
  "403",
])

const CONTEXT_CODES = new Set([
  "context_overflow",
  "context_length_exceeded",
  "context_window_exceeded",
  "max_tokens_exceeded",
  "prompt_too_long",
  "token_limit_exceeded",
  "too_long",
])

const PROVIDER_CODES = new Set([
  "provider_error",
  "server_error",
  "internal_error",
  "internal_server_error",
  "bad_gateway",
  "service_unavailable",
  "upstream_error",
  "upstream_unavailable",
  "overloaded",
  "500",
  "502",
  "503",
])

/** Keyword-only fallbacks, tried in order when no stable code matched. */
const MESSAGE_PATTERNS: ReadonlyArray<{ reason: FallbackReason; pattern: RegExp }> = [
  {
    reason: "rate_limit",
    pattern: /\b(?:rate[ _-]?limit(?:ed|ing)?|too many requests|429)\b/i,
  },
  {
    reason: "context_overflow",
    pattern:
      /\b(?:context[ _-]?(?:window|length)|maximum context|prompt is too long|too many tokens)\b/i,
  },
  {
    reason: "timeout",
    pattern: /\b(?:timed?[ _-]?out|timeout|deadline exceeded|504)\b/i,
  },
  {
    reason: "auth",
    pattern:
      /\b(?:unauthori[sz]ed|invalid api key|authentication failed|forbidden|401|403)\b/i,
  },
  {
    reason: "provider_error",
    pattern:
      /\b(?:internal server error|bad gateway|service unavailable|upstream error|50[023])\b/i,
  },
]

/** `Provider-Error` and `RATE LIMIT` name the same stable code. */
function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]+/g, "_")
}

function classifyCode(code: string): FallbackReason | undefined {
  if (code === "") return undefined
  if (RATE_LIMIT_CODES.has(code)) return "rate_limit"
  if (TIMEOUT_CODES.has(code)) return "timeout"
  if (AUTH_CODES.has(code)) return "auth"
  if (CONTEXT_CODES.has(code)) return "context_overflow"
  if (PROVIDER_CODES.has(code)) return "provider_error"
  return undefined
}

/**
 * Classifies a failure from its stable code first, then from bounded message
 * keywords. `retryable` is an advisory host flag, not a category: `true`
 * cannot rescue an `auth` or unknown failure, and `false` does not erase a
 * stable code, because the live adapter sets it only for a retry-after hint.
 */
export function classifyFailure(failure: TurnFailure): FallbackReason {
  const byCode = classifyCode(normalizeCode(failure.code ?? ""))
  if (byCode) return byCode

  const message = (failure.message ?? "").slice(0, MESSAGE_PATTERN_LIMIT)
  if (message === "") return "unknown"
  for (const entry of MESSAGE_PATTERNS) {
    if (entry.pattern.test(message)) return entry.reason
  }
  return "unknown"
}

/** True for the four failure kinds a fallback may follow. */
export function isRetryable(reason: FallbackReason): boolean {
  return RETRYABLE_REASONS.has(reason)
}

/**
 * First chain entry not already tried. Entries compare by provider, model and
 * variant; an empty chain or a fully tried one yields `undefined`.
 */
export function nextModel(
  policy: TurnPolicy,
  tried: readonly ModelRef[],
): ModelRef | undefined {
  const seen = new Set(tried.map(modelKey))
  return policy.chain.find((entry) => !seen.has(modelKey(entry)))
}

/**
 * Free is an explicit classification, never inferred from a provider name or
 * a price field the core does not have.
 */
export function isFreeModel(entry: ModelRef): boolean {
  return entry.isFree === true
}

export interface FallbackDecisionInput {
  policy: TurnPolicy
  failure: TurnFailure
  /**
   * Assistant text emitted by the failed attempt. Whitespace counts: any
   * output means the stream is no longer cleanly retryable.
   */
  emittedText: string
  /** Completed attempts in this turn; the first failed attempt is `1`. */
  attempts: number
  /** Paid turns already recorded today. */
  paidTurns: number
  /** Candidate for the retry, normally `nextModel(policy, tried)`. */
  next?: ModelRef
  /** Model that just failed; its context window gates an overflow retry. */
  current?: ModelRef
}

/**
 * Allows at most one retry per chat turn: only after the first attempt, only
 * without assistant output, only for a retryable failure, only when a next
 * entry exists, and only while the next entry is free or the paid turn budget
 * has room. `paidDailyTurns: 0` means the cap is off.
 *
 * A `context_overflow` retry is skipped when both models' windows are known
 * and the next one is not larger: re-sending the same context there cannot
 * succeed. An unknown window keeps the retry possible.
 */
export function shouldFallback(input: FallbackDecisionInput): boolean {
  const { policy, failure, emittedText, attempts, paidTurns, next, current } = input
  if (policy.surface !== "chat") return false
  if (policy.chain.length === 0) return false
  if (next === undefined) return false
  if (attempts !== 1) return false
  if (emittedText.length > 0) return false
  const reason = classifyFailure(failure)
  if (!isRetryable(reason)) return false
  if (
    reason === "context_overflow" &&
    current?.contextLimit !== undefined &&
    next.contextLimit !== undefined &&
    next.contextLimit <= current.contextLimit
  ) {
    return false
  }
  if (isFreeModel(next)) return true
  return policy.paidDailyTurns === 0 || paidTurns < policy.paidDailyTurns
}
