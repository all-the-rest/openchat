/**
 * PWA shell: offline state, install hint and deployment updates.
 *
 * The manifest generator sources its name/description from these descriptors
 * (`pwa.name`, `pwa.shortName`, `pwa.description`), so the install metadata and
 * the in-app notices share one English source. German lives in the PO catalog.
 */
import { msg } from "@lingui/core/macro"

export const pwa = {
  "pwa.name": msg({ id: "pwa.name", message: "OpenChat" }),
  "pwa.shortName": msg({ id: "pwa.shortName", message: "OpenChat" }),
  "pwa.description": msg({
    id: "pwa.description",
    message: "A self-hosted workspace for your agent, available offline.",
  }),

  "offline.title": msg({ id: "offline.title", message: "You are offline" }),
  "offline.hint": msg({
    id: "offline.hint",
    message: "OpenChat needs a connection to load chats and send messages. Reconnect to continue.",
  }),
  "offline.composerHint": msg({
    id: "offline.composerHint",
    message: "Sending is unavailable while offline. Reconnect to start a new prompt.",
  }),

  "update.title": msg({ id: "update.title", message: "A new version is available" }),
  "update.hint": msg({
    id: "update.hint",
    message: "Reload when you are ready. Nothing changes until you do.",
  }),
  "update.reload": msg({ id: "update.reload", message: "Reload to update" }),
  "update.dismiss": msg({ id: "update.dismiss", message: "Later" }),
  "update.streamingHint": msg({
    id: "update.streamingHint",
    message: "Wait for the current answer to finish before reloading.",
  }),

  "install.hint": msg({
    id: "install.hint",
    message: "Install OpenChat on this device for quick access.",
  }),
  "install.install": msg({ id: "install.install", message: "Install" }),
  "install.dismiss": msg({ id: "install.dismiss", message: "Dismiss" }),
} as const
