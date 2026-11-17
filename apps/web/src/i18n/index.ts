import { de } from "./messages/de"
import { en, type MessageKey, type MessageVars } from "./messages/en"

export type { MessageKey, MessageVars }

export type Locale = "en" | "de"

export const LOCALES: readonly Locale[] = ["en", "de"]

export const LOCALE_STORAGE_KEY = "openchat.locale"

export const catalogs: Record<Locale, Record<MessageKey, string>> = { en, de }

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "de"
}

/**
 * Stored setting → navigator.language → English (spec 12).
 */
export function resolveLocale(): Locale {
  if (typeof window === "undefined") return "en"
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // Storage may be unavailable (private mode, blocked cookies); fall through.
  }
  const preferred = typeof navigator !== "undefined" ? navigator.language : ""
  return preferred.toLowerCase().startsWith("de") ? "de" : "en"
}

export function translate(locale: Locale, key: MessageKey, vars?: MessageVars): string {
  const catalog = catalogs[locale] ?? catalogs.en
  const template = catalog[key] ?? catalogs.en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}
