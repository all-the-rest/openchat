import type { EventEnvelope } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"

/**
 * Token counters for one chat. Every field is optional on the wire: a host that
 * does not report a counter leaves it absent, and the UI renders "not reported"
 * instead of substituting a number. This module is the single source shared by
 * the usage panel and the context-fill indicator (issue #53).
 */
export interface UsageSnapshot {
  input?: number
  output?: number
  cached?: number
}

function counter(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return value
}

/** Reads one `session.usage.updated` event. Malformed data yields an empty snapshot. */
export function usageFromEvent(event: EventEnvelope): UsageSnapshot | null {
  if (event.type !== EVENT.usageUpdated) return null
  const data = event.data
  const snapshot: UsageSnapshot = {}
  const input = counter(data.input)
  const output = counter(data.output)
  const cached = counter(data.cached)
  if (input !== undefined) snapshot.input = input
  if (output !== undefined) snapshot.output = output
  if (cached !== undefined) snapshot.cached = cached
  return Object.keys(snapshot).length === 0 ? null : snapshot
}

/** Folds a usage event into the current snapshot; every other event is a no-op. */
export function applyUsageEvent(
  current: UsageSnapshot | null,
  event: EventEnvelope,
): UsageSnapshot | null {
  return usageFromEvent(event) ?? current
}

/** True when the host reported at least one counter. */
export function hasUsage(snapshot: UsageSnapshot | null): boolean {
  return snapshot !== null && Object.keys(snapshot).length > 0
}

/**
 * A model's reported context limit, or null when the host did not report one.
 * `models[0]` is the fallback when no model is selected, matching the picker.
 */
export function contextLimitFor(
  models: readonly { id: string; contextLimit?: number }[],
  modelID: string | null,
): number | null {
  const model = (modelID ? models.find((entry) => entry.id === modelID) : undefined) ?? models[0]
  const limit = model?.contextLimit
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null
}

/**
 * Fraction of the context window in use, clamped to [0, 1]. Returns null unless
 * all three counters and the limit are reported — a partial snapshot must never
 * produce a number the host did not give us.
 */
export function contextFill(
  snapshot: UsageSnapshot | null,
  limit: number | null,
): number | null {
  if (!snapshot || limit === null || !Number.isFinite(limit) || limit <= 0) return null
  const { input, output, cached } = snapshot
  if (input === undefined || output === undefined || cached === undefined) return null
  return Math.min(1, (input + cached + output) / limit)
}
