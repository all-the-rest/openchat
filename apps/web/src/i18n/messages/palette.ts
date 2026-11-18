/**
 * Command palette strings.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const palette = {
  "palette.open": msg({ id: "palette.open", message: "Open command palette" }),
  "palette.label": msg({ id: "palette.label", message: "Command palette" }),
  "palette.close": msg({ id: "palette.close", message: "Close command palette" }),
  "palette.placeholder": msg({ id: "palette.placeholder", message: "Search chats or run a command" }),
  "palette.actions": msg({ id: "palette.actions", message: "Actions" }),
  "palette.chats": msg({ id: "palette.chats", message: "Chats" }),
  "palette.recent": msg({ id: "palette.recent", message: "Recent chats" }),
  "palette.searching": msg({ id: "palette.searching", message: "Searching chats…" }),
  "palette.searchFailed": msg({ id: "palette.searchFailed", message: "Chat search failed." }),
  "palette.noResults": msg({ id: "palette.noResults", message: "No chats match “{query}”." }),
  "palette.hint": msg({ id: "palette.hint", message: "↑↓ to move · Enter to open · Esc to close" }),
  "palette.action.newChat": msg({ id: "palette.action.newChat", message: "New chat" }),
  "palette.action.chat": msg({ id: "palette.action.chat", message: "Go to chat" }),
  "palette.action.settings": msg({ id: "palette.action.settings", message: "Go to settings" }),
  "palette.action.apps": msg({ id: "palette.action.apps", message: "Go to apps" }),
  "palette.action.artifacts": msg({ id: "palette.action.artifacts", message: "Go to artifacts" }),
  "palette.action.code": msg({ id: "palette.action.code", message: "Go to code" }),
  "palette.action.copyAnswer": msg({ id: "palette.action.copyAnswer", message: "Copy current answer" }),
  "palette.copyUnavailable": msg({ id: "palette.copyUnavailable", message: "No answer to copy yet" }),
  "palette.action.language": msg({ id: "palette.action.language", message: "Switch language to {language}" }),
  "palette.copied": msg({ id: "palette.copied", message: "Answer copied to clipboard." }),
  "palette.copyFailed": msg({ id: "palette.copyFailed", message: "The answer could not be copied." }),
} as const
