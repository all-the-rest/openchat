/**
 * App shell, navigation and host status.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const shell = {
  "app.name": msg({ id: "app.name", message: "OpenChat" }),
  "app.tagline": msg({ id: "app.tagline", message: "A workspace for your agent." }),
  "app.loading": msg({ id: "app.loading", message: "Loading…" }),

  "host.unreachable": msg({ id: "host.unreachable", message: "OpenCode host not reachable" }),
  "host.unreachableHint": msg({ id: "host.unreachableHint", message: "The app is running, but the OpenCode host did not answer. Retry once the tunnel is back." }),
  "host.retry": msg({ id: "host.retry", message: "Retry" }),

  "nav.skipToContent": msg({ id: "nav.skipToContent", message: "Skip to content" }),
  "nav.openSidebar": msg({ id: "nav.openSidebar", message: "Open chat list" }),
  "nav.closeSidebar": msg({ id: "nav.closeSidebar", message: "Close chat list" }),
  "nav.chats": msg({ id: "nav.chats", message: "Chats" }),
  "nav.sessionsLabel": msg({ id: "nav.sessionsLabel", message: "Chat sessions" }),
  "nav.newChat": msg({ id: "nav.newChat", message: "New chat" }),
  "nav.main": msg({ id: "nav.main", message: "Main navigation" }),
  "nav.search": msg({ id: "nav.search", message: "Search" }),
  "nav.apps": msg({ id: "nav.apps", message: "Apps" }),
  "nav.artifacts": msg({ id: "nav.artifacts", message: "Artifacts" }),

  "menu.trigger": msg({ id: "menu.trigger", message: "Open menu" }),
  "menu.label": msg({ id: "menu.label", message: "App menu" }),

  "surface.label": msg({ id: "surface.label", message: "Surface" }),
  "surface.chat": msg({ id: "surface.chat", message: "Chat" }),
  "surface.code": msg({ id: "surface.code", message: "Code" }),
} as const
