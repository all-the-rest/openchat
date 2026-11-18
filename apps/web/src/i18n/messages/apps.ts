/**
 * MCP servers and skills.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const apps = {
  "apps.title": msg({ id: "apps.title", message: "Apps" }),
  "apps.description": msg({ id: "apps.description", message: "MCP servers and skills of this workspace. Status comes from the host." }),
  "apps.servers": msg({ id: "apps.servers", message: "Servers" }),
  "apps.skills": msg({ id: "apps.skills", message: "Skills" }),
  "apps.loading": msg({ id: "apps.loading", message: "Loading apps…" }),
  "apps.loadFailed": msg({ id: "apps.loadFailed", message: "Apps could not be loaded." }),
  "apps.retry": msg({ id: "apps.retry", message: "Retry" }),
  "apps.noServers": msg({ id: "apps.noServers", message: "No MCP servers are configured." }),
  "apps.noSkills": msg({ id: "apps.noSkills", message: "No skills are available." }),
  "apps.unavailable": msg({ id: "apps.unavailable", message: "Apps are not available in this deployment." }),
  "apps.connect": msg({ id: "apps.connect", message: "Connect" }),
  "apps.disconnect": msg({ id: "apps.disconnect", message: "Disconnect" }),
  "apps.connectServer": msg({ id: "apps.connectServer", message: "Connect {server}" }),
  "apps.disconnectServer": msg({ id: "apps.disconnectServer", message: "Disconnect {server}" }),
  "apps.auto": msg({ id: "apps.auto", message: "Auto" }),
  "apps.autoHint": msg({ id: "apps.autoHint", message: "Runs automatically when relevant" }),
  "apps.disabledNote": msg({ id: "apps.disabledNote", message: "Disabled in the host configuration." }),
  "apps.action.connectDone": msg({ id: "apps.action.connectDone", message: "{server} connected." }),
  "apps.action.disconnectDone": msg({ id: "apps.action.disconnectDone", message: "{server} disconnected." }),
  "apps.error.unknownServer": msg({ id: "apps.error.unknownServer", message: "This server is no longer configured." }),
  "apps.error.throttled": msg({ id: "apps.error.throttled", message: "Too many attempts. Try again shortly." }),
  "apps.error.throttledAfter": msg({ id: "apps.error.throttledAfter", message: "Too many attempts. Try again in {seconds} s." }),
  "apps.error.host": msg({ id: "apps.error.host", message: "The host did not answer." }),
  "apps.error.failed": msg({ id: "apps.error.failed", message: "The action failed." }),
} as const
