import type { Locale } from "../i18n"

/** Relative timestamps for the sidebar, formatted with the active locale. */
export function relativeTime(timestamp: number, locale: Locale, now = Date.now()): string {
  const diff = timestamp - now
  const absolute = Math.abs(diff)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })

  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day
  const year = 365 * day

  if (absolute < minute) return formatter.format(Math.round(diff / 1000), "second")
  if (absolute < hour) return formatter.format(Math.round(diff / minute), "minute")
  if (absolute < day) return formatter.format(Math.round(diff / hour), "hour")
  if (absolute < week) return formatter.format(Math.round(diff / day), "day")
  if (absolute < month) return formatter.format(Math.round(diff / week), "week")
  if (absolute < year) return formatter.format(Math.round(diff / month), "month")
  return formatter.format(Math.round(diff / year), "year")
}

/** Tool duration, locale aware; sub-second values use a millisecond unit. */
export function formatDuration(startedAt: number, endedAt: number, locale: Locale): string {
  const elapsed = Math.max(0, endedAt - startedAt)
  if (elapsed < 1000) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "millisecond",
      maximumFractionDigits: 0,
    }).format(Math.round(elapsed))
  }
  if (elapsed < 60_000) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      maximumFractionDigits: 1,
    }).format(elapsed / 1000)
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "minute",
    maximumFractionDigits: 1,
  }).format(elapsed / 60_000)
}
