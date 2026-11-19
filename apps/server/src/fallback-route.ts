/**
 * Read-only view of the fallback settings the server actually enforces. It
 * reports the same resolved `TurnPolicy` the prompt route uses and today's
 * counters from the same ledger the engine records into, so the settings page
 * cannot drift from enforcement. Nothing secret (the raw chain JSON, tokens,
 * the ledger directory) is part of the answer.
 */
import type { Hono } from "hono"
import type { FallbackStatusResponse, ModelRef, TurnPolicy } from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { UsageLedger } from "./usage-ledger"

/** Only the read side of the ledger is needed; the route never writes. */
export type FallbackUsage = Pick<UsageLedger, "paidTurnsToday" | "turnsToday">

export interface FallbackRouteDeps {
  /** The resolved chat policy the prompt route enforces. */
  policy: TurnPolicy
  /** The ledger instance the engine records into. */
  ledger: FallbackUsage
  /**
   * Validation message for a rejected `FALLBACK_CHAIN_JSON`. The route reports
   * only that the setting is invalid plus this short reason, never the value.
   */
  invalidReason?: string
}

/** A reason longer than this turns into noise in a settings card. */
const MAX_REASON_LENGTH = 200

function shortReason(reason: string): string {
  const trimmed = reason.trim()
  return trimmed.length > MAX_REASON_LENGTH
    ? `${trimmed.slice(0, MAX_REASON_LENGTH - 1)}…`
    : trimmed
}

/**
 * Copies only the fields the settings surface renders, so a future policy field
 * cannot leak through this route by accident.
 */
function entryOf(entry: ModelRef): ModelRef {
  return {
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.variant === undefined ? {} : { variant: entry.variant }),
    ...(entry.isFree === undefined ? {} : { isFree: entry.isFree }),
    ...(entry.contextLimit === undefined ? {} : { contextLimit: entry.contextLimit }),
  }
}

/** Registers `GET /api/fallback`; the guards and auth middleware have run. */
export function registerFallbackRoute(app: Hono<AppEnv>, deps: FallbackRouteDeps): void {
  app.get("/api/fallback", async (c) => {
    const [paidTurnsToday, turnsToday] = await Promise.all([
      deps.ledger.paidTurnsToday(),
      deps.ledger.turnsToday(),
    ])
    c.header("Cache-Control", "no-store")
    const reason = deps.invalidReason
    return c.json({
      configured: deps.policy.chain.length > 0,
      invalid: reason !== undefined,
      ...(reason === undefined ? {} : { invalidReason: shortReason(reason) }),
      chain: deps.policy.chain.map(entryOf),
      paidDailyCap: deps.policy.paidDailyTurns,
      paidTurnsToday,
      turnsToday,
    } satisfies FallbackStatusResponse)
  })
}
