import { read, readTokenCap, type EnvSource } from "./env-parse"

/**
 * The paid-turn cap, a **turn count** per local day where `0` disables it.
 *
 * Release 2.5.0 documented `FALLBACK_PAID_DAILY_CAP` with a micros name and
 * description but parsed it as a turn count. The old name stays accepted so an
 * upgrade keeps its effective cap; it is read as turns too and warns once that
 * it is deprecated. The new name wins when both are set. The value itself is
 * never echoed.
 */
export function readFallbackPaidTurns(
  source: EnvSource,
  warn: (message: string) => void,
): number {
  const legacy = read(source, "FALLBACK_PAID_DAILY_CAP")
  if (legacy !== undefined) {
    warn(
      "FALLBACK_PAID_DAILY_CAP is deprecated and is now counted in turns; " +
        "use FALLBACK_PAID_DAILY_TURNS",
    )
  }
  if (read(source, "FALLBACK_PAID_DAILY_TURNS") !== undefined) {
    return readTokenCap(source, "FALLBACK_PAID_DAILY_TURNS", 0, warn)
  }
  return readTokenCap(source, "FALLBACK_PAID_DAILY_CAP", 0, warn)
}
