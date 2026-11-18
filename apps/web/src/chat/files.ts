import type { Locale } from "../i18n"

const UNITS = [
  { limit: 1024 ** 3, unit: "gigabyte" },
  { limit: 1024 ** 2, unit: "megabyte" },
  { limit: 1024, unit: "kilobyte" },
] as const

/**
 * Human size for a chat file and for the quota line. `formatBytes` in the
 * artifact list stops at kilobytes, which turns "100 MiB" into six digits of
 * kilobytes; a chat file can reach megabytes, so this helper scales further.
 */
export function formatChatFileSize(bytes: number, locale: Locale): string {
  const value = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
  for (const { limit, unit } of UNITS) {
    if (value >= limit) {
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "narrow",
        maximumFractionDigits: 1,
      }).format(value / limit)
    }
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "byte",
    unitDisplay: "narrow",
    maximumFractionDigits: 0,
  }).format(value)
}
