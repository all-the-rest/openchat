/**
 * Theme and interface language.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const settings = {
  "theme.label": msg({ id: "theme.label", message: "Theme" }),
  "theme.toggleToLight": msg({ id: "theme.toggleToLight", message: "Switch to light theme" }),
  "theme.toggleToDark": msg({ id: "theme.toggleToDark", message: "Switch to dark theme" }),

  "language.label": msg({ id: "language.label", message: "Interface language" }),
  "language.en": msg({ id: "language.en", message: "English" }),
  "language.de": msg({ id: "language.de", message: "Deutsch" }),

  "settings.title": msg({ id: "settings.title", message: "Settings" }),
  "settings.defaults": msg({ id: "settings.defaults", message: "Defaults for new chats" }),
  "settings.serverStatus": msg({ id: "settings.serverStatus", message: "Server status" }),
  "settings.version": msg({ id: "settings.version", message: "Version" }),
  "settings.hostReachable": msg({ id: "settings.hostReachable", message: "Host reachable" }),
  "settings.hostUnreachable": msg({ id: "settings.hostUnreachable", message: "Host not reachable" }),
  "settings.dictation": msg({ id: "settings.dictation", message: "Dictation" }),
  "settings.documents": msg({ id: "settings.documents", message: "Documents" }),
  "settings.available": msg({ id: "settings.available", message: "Available" }),
  "settings.unavailable": msg({ id: "settings.unavailable", message: "Unavailable" }),
  "settings.loading": msg({ id: "settings.loading", message: "Loading…" }),
  "settings.loadFailed": msg({ id: "settings.loadFailed", message: "Server status could not be loaded." }),
  "settings.fallback": msg({ id: "settings.fallback", message: "Model fallback" }),
  "settings.fallbackUnconfigured": msg({ id: "settings.fallbackUnconfigured", message: "No fallback chain is configured." }),
  "settings.fallbackInvalid": msg({ id: "settings.fallbackInvalid", message: "The configured fallback chain is invalid; fallback is off." }),
  "settings.fallbackInvalidChainJson": msg({ id: "settings.fallbackInvalidChainJson", message: "The chain setting is not valid JSON." }),
  "settings.fallbackInvalidChainShape": msg({ id: "settings.fallbackInvalidChainShape", message: "The chain must be a JSON array with at most 5 entries." }),
  "settings.fallbackInvalidEntry": msg({ id: "settings.fallbackInvalidEntry", message: "One chain entry is invalid or duplicated." }),
  "settings.fallbackLedgerError": msg({ id: "settings.fallbackLedgerError", message: "Turn accounting could not be written; today's usage may be incomplete." }),
  "settings.fallbackLoadFailed": msg({ id: "settings.fallbackLoadFailed", message: "Fallback settings could not be loaded." }),
  "settings.fallbackRetry": msg({ id: "settings.fallbackRetry", message: "Retry" }),
  "settings.fallbackPaidCap": msg({ id: "settings.fallbackPaidCap", message: "Paid-turn cap" }),
  "settings.fallbackCapValue": msg({ id: "settings.fallbackCapValue", message: "{cap, plural, one {# paid turn per day} other {# paid turns per day}}" }),
  "settings.fallbackCapOff": msg({ id: "settings.fallbackCapOff", message: "Off" }),
  "settings.fallbackPaidTurnsToday": msg({ id: "settings.fallbackPaidTurnsToday", message: "Paid turns today" }),
  "settings.fallbackTurnsToday": msg({ id: "settings.fallbackTurnsToday", message: "Turns today" }),
  "settings.fallbackVariant": msg({ id: "settings.fallbackVariant", message: "Variant: {variant}" }),
  "settings.fallbackFree": msg({ id: "settings.fallbackFree", message: "Free" }),
  "settings.fallbackReadOnly": msg({ id: "settings.fallbackReadOnly", message: "Configured on the server. This page only reads the effective settings." }),
  "settings.hostDefault": msg({ id: "settings.hostDefault", message: "Host default model" }),
  "settings.hostDefaultUnset": msg({ id: "settings.hostDefaultUnset", message: "Not set" }),
  "settings.hostDefaultUnavailable": msg({ id: "settings.hostDefaultUnavailable", message: "The host default could not be read." }),
  "settings.hostDefaultHint": msg({ id: "settings.hostDefaultHint", message: "OpenCode chooses this on the host. Change it in the OpenCode configuration; OpenChat only reads it." }),
} as const
