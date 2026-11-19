/**
 * Keyboard-shortcuts help overlay.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const shortcuts = {
  "shortcuts.title": msg({ id: "shortcuts.title", message: "Keyboard shortcuts" }),
  "shortcuts.close": msg({ id: "shortcuts.close", message: "Close keyboard shortcuts" }),

  "shortcuts.keys.palette": msg({ id: "shortcuts.keys.palette", message: "Ctrl/Cmd + K" }),
  "shortcuts.keys.newChat": msg({ id: "shortcuts.keys.newChat", message: "Shift + N" }),
  "shortcuts.keys.surface": msg({ id: "shortcuts.keys.surface", message: "Ctrl/Cmd + Shift + M" }),
  "shortcuts.keys.escape": msg({ id: "shortcuts.keys.escape", message: "Escape" }),

  "shortcuts.list.palette": msg({
    id: "shortcuts.list.palette",
    message: "Open the command palette",
  }),
  "shortcuts.list.newChat": msg({ id: "shortcuts.list.newChat", message: "Start a new chat" }),
  "shortcuts.list.surface": msg({ id: "shortcuts.list.surface", message: "Switch surface" }),
  "shortcuts.list.escape": msg({
    id: "shortcuts.list.escape",
    message: "Close an overlay or stop editing",
  }),
} as const
