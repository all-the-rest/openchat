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
    return c.json({
      configured: deps.policy.chain.length > 0,
      chain: deps.policy.chain.map(entryOf),
      paidDailyCap: deps.policy.paidDailyTurns,
      paidTurnsToday,
      turnsToday,
    } satisfies FallbackStatusResponse)
  })
}
