import { z } from "zod"

/**
 * One model the turn engine may prompt, identified the way the host does.
 * `isFree` is explicit because the core has no price data: an entry without
 * the flag is treated as paid, and a free entry may be reached even when the
 * paid budget is exhausted.
 */
export interface ModelRef {
  providerID: string
  modelID: string
  /** Optional reasoning variant forwarded with the model. */
  variant?: string
  /** True when this model bills nothing. Absent means paid. */
  isFree?: boolean
  /**
   * Prompt-token window of the model, when known. A context-overflow retry is
   * pointless on a model that cannot hold more than the one that just failed.
   */
  contextLimit?: number
}

/** Which surface owns a turn; only chat applies the fallback chain. */
export type TurnSurface = "chat" | "code"

export interface TurnPolicy {
  surface: TurnSurface
  /**
   * Ordered candidates. Chat starts at the preferred entry; the Code surface
   * carries an empty chain so its model choice is untouched.
   */
  chain: ModelRef[]
  /**
   * Paid turns allowed per local day. A turn counts when the answered model is
   * not marked free. `0` turns the cap off.
   */
  paidDailyTurns: number
  /** Prompt tokens before compaction is preferred. `0` turns the cap off. */
  contextSoftCap: number
}

/**
 * Why a turn failed. Only the first four are retryable; `auth` needs owner
 * action and `unknown` must not be guessed at.
 */
export type FallbackReason =
  | "rate_limit"
  | "provider_error"
  | "timeout"
  | "context_overflow"
  | "auth"
  | "unknown"

/**
 * What one turn actually did. `attempts` counts completed attempts, so a
 * fallback turn that failed twice reports `2`.
 */
export interface TurnOutcome {
  requested: ModelRef
  answered?: ModelRef
  fellBack: boolean
  reason?: FallbackReason
  attempts: number
}

/**
 * `GET /api/fallback`: the effective fallback settings the server enforces.
 * Only resolved, non-secret values appear here — never the raw environment
 * value, credentials or the usage-ledger path. `configured` is false exactly
 * when the chain is empty, the same condition the prompt route checks.
 */
export interface FallbackStatusResponse {
  configured: boolean
  /** Ordered candidates as the policy resolved them; empty when unconfigured. */
  chain: ModelRef[]
  /** Paid turns allowed per local day; `0` means the cap is off. */
  paidDailyCap: number
  /** Paid turns the ledger recorded for today; free turns are excluded. */
  paidTurnsToday: number
  /** All turns recorded for today, free and paid alike. */
  turnsToday: number
}

/** Longest accepted chain. One retry per turn needs no more than two entries. */
export const MAX_CHAIN_LENGTH = 5

export const modelRefSchema = z.object({
  providerID: z.string().trim().min(1).max(100),
  modelID: z.string().trim().min(1).max(200),
  variant: z.string().trim().min(1).max(100).optional(),
  isFree: z.boolean().optional(),
  contextLimit: z.number().int().positive().optional(),
})

/**
 * Stable identity of a chain entry. Two entries are duplicates only when
 * provider, model and variant all match, so the same model with a different
 * reasoning variant is a valid second candidate.
 */
export function modelKey(entry: ModelRef): string {
  return `${entry.providerID}\u0000${entry.modelID}\u0000${entry.variant ?? ""}`
}

export const turnPolicySchema = z
  .object({
    surface: z.enum(["chat", "code"]),
    chain: z.array(modelRefSchema).max(MAX_CHAIN_LENGTH),
    paidDailyTurns: z.number().int().min(0),
    contextSoftCap: z.number().int().min(0),
  })
  .superRefine((policy, ctx) => {
    const seen = new Set<string>()
    policy.chain.forEach((entry, index) => {
      const key = modelKey(entry)
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate model in chain: ${entry.providerID}/${entry.modelID}`,
          path: ["chain", index],
        })
      }
      seen.add(key)
    })
  })
