import type { Locale } from "../i18n"

/** Epoch ms to a locale-aware date and time, or nothing when the host omitted it. */
export function formatWhen(epoch: number | undefined, locale: Locale): string | undefined {
  if (epoch === undefined || !Number.isFinite(epoch)) return undefined
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(epoch)
}
