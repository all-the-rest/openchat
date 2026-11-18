import { contextTokens } from "@openchat/contracts"
import type { Message, TokenUsage } from "@openchat/contracts"

/** A displayed context fill; `percent` is clamped so an overrun never lies. */
export interface ContextFill {
  used: number
  limit: number
  percent: number
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Reads a host usage payload; anything incomplete is unknown, never zero. */
export function readTokenUsage(value: unknown): TokenUsage | null {
  if (value === null || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const cache = record.cache
  if (cache === null || typeof cache !== "object") return null
  const cacheRecord = cache as Record<string, unknown>
  const input = finiteNumber(record.input)
  const output = finiteNumber(record.output)
  const reasoning = finiteNumber(record.reasoning)
  const read = finiteNumber(cacheRecord.read)
  const write = finiteNumber(cacheRecord.write)
  if (input === null || output === null || reasoning === null || read === null || write === null) {
    return null
  }
  return { input, output, reasoning, cache: { read, write } }
}

/** Last usage a session read reported; a reload restores the meter from it. */
export function lastMessageUsage(messages: Message[]): TokenUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage
    if (usage) return usage
  }
  return null
}

/**
 * Arithmetic for the header fill: used prompt tokens over the model window.
 * Missing usage or a host without a window is `null`, and the UI stays neutral.
 */
export function contextFill(
  usage: TokenUsage | null | undefined,
  limit: number | null | undefined,
): ContextFill | null {
  if (!usage || limit === null || limit === undefined) return null
  if (!Number.isFinite(limit) || limit <= 0) return null
  const used = contextTokens(usage)
  if (!Number.isFinite(used) || used < 0) return null
  return { used, limit, percent: Math.min(100, Math.round((used / limit) * 100)) }
}
