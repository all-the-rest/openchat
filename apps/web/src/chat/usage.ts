import { EVENT } from "@openchat/contracts"
import type { EventEnvelope, UsageReport } from "@openchat/contracts"

/**
 * Reported token usage for one chat (spec 02, issue #8). The module is pure so
 * the context-fill indicator planned in #53 can share the same parsing and the
 * same "never invent a number" rule.
 */
export interface UsageView {
  /** False when the host has reported nothing for this chat. */
  reported: boolean
  input: number | null
  output: number | null
  cached: number | null
  contextLimit: number | null
}

const EMPTY: UsageView = {
  reported: false,
  input: null,
  output: null,
  cached: null,
  contextLimit: null,
}

/** A non-negative integer token count, or `null` when the value is not one. */
function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

function cacheRead(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined
  return (value as Record<string, unknown>).read
}

/**
 * Validates one reported usage object. Hosts differ in casing and nesting, so
 * `cached` may arrive directly or as the provider's `cache.read`. A report
 * whose counters are all zero carries no information and is treated as absent.
 */
export function readUsage(value: unknown): UsageReport | null {
  if (value === null || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const input = count(raw.input)
  const output = count(raw.output)
  // Both counters are required. Substituting a zero for a malformed one would
  // be exactly the invented number this module exists to avoid.
  if (input === null || output === null) return null
  const cached = count(raw.cached) ?? count(cacheRead(raw.cache))
  const report: UsageReport = { input, output }
  if (cached !== null && cached > 0) report.cached = cached
  const total = report.input + report.output + (report.cached ?? 0)
  return total > 0 ? report : null
}

/**
 * Usage from a `session.usage.updated` event. The live adapter forwards the
 * host payload (`tokens`), while the fake and the session snapshot use
 * `usage`; both shapes are accepted without trusting either.
 */
export function usageFromEvent(event: EventEnvelope): UsageReport | null {
  if (event.type !== EVENT.usageUpdated) return null
  return readUsage(event.data.usage ?? event.data.tokens)
}

export interface ContextFill {
  used: number
  limit: number
  /** 0…1, clamped; a reported count above the window shows a full bar. */
  ratio: number
}

/**
 * Fill of the model's context window from the numbers the host reported.
 * `null` whenever either side is missing, so a caller never renders a made-up
 * percentage (#53).
 */
export function contextFill(view: UsageView): ContextFill | null {
  if (!view.reported || view.contextLimit === null) return null
  const used = (view.input ?? 0) + (view.output ?? 0)
  if (used <= 0) return null
  return {
    used,
    limit: view.contextLimit,
    ratio: Math.min(1, used / view.contextLimit),
  }
}

/** The complete view model of the usage panel's numbers. */
export function usageView(
  report: UsageReport | null | undefined,
  contextLimit?: number | null,
): UsageView {
  const parsed = readUsage(report)
  if (!parsed) return EMPTY
  const limit = count(contextLimit)
  return {
    reported: true,
    input: parsed.input,
    output: parsed.output,
    cached: parsed.cached ?? null,
    contextLimit: limit !== null && limit > 0 ? limit : null,
  }
}
