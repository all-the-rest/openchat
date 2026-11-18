/**
 * Search page and result groups.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const search = {
  "search.title": msg({ id: "search.title", message: "Search" }),
  "search.description": msg({ id: "search.description", message: "One query across chats, workspace, web and apps." }),
  "search.label": msg({ id: "search.label", message: "Search term" }),
  "search.placeholder": msg({ id: "search.placeholder", message: "Search chats, files, web and apps" }),
  "search.sources": msg({ id: "search.sources", message: "Sources" }),
  "search.unavailable": msg({ id: "search.unavailable", message: "not configured" }),
  "search.sourceChats": msg({ id: "search.sourceChats", message: "Chats" }),
  "search.sourceWorkspace": msg({ id: "search.sourceWorkspace", message: "Workspace" }),
  "search.sourceWeb": msg({ id: "search.sourceWeb", message: "Web" }),
  "search.sourceApps": msg({ id: "search.sourceApps", message: "Apps" }),
  "search.kindSkill": msg({ id: "search.kindSkill", message: "Skill" }),
  "search.kindServer": msg({ id: "search.kindServer", message: "MCP server" }),
  "search.kindTool": msg({ id: "search.kindTool", message: "Tool" }),
  "search.status.connected": msg({ id: "search.status.connected", message: "Connected" }),
  "search.status.pending": msg({ id: "search.status.pending", message: "Pending" }),
  "search.status.needsAuth": msg({ id: "search.status.needsAuth", message: "Needs auth" }),
  "search.status.failed": msg({ id: "search.status.failed", message: "Failed" }),
  "search.status.disabled": msg({ id: "search.status.disabled", message: "Disabled" }),
  "search.status.available": msg({ id: "search.status.available", message: "Available" }),
  "search.groupCount": msg({ id: "search.groupCount", message: "{count} found" }),
  "search.groupFailed": msg({ id: "search.groupFailed", message: "Search failed" }),
  "search.groupDisabled": msg({ id: "search.groupDisabled", message: "Not configured" }),
  "search.disabledHint": msg({ id: "search.disabledHint", message: "This source is not configured on the host and was not queried." }),
  "search.lastSource": msg({ id: "search.lastSource", message: "At least one source must stay selected." }),
  "search.webHint": msg({ id: "search.webHint", message: "Web is searched when you press Enter." }),
  "search.noSources": msg({ id: "search.noSources", message: "No source is available for this query." }),
  "search.opensInNewTab": msg({ id: "search.opensInNewTab", message: "opens in a new tab" }),
  "search.prompt": msg({ id: "search.prompt", message: "Type a search term." }),
  "search.failed": msg({ id: "search.failed", message: "The search failed." }),
  "search.retry": msg({ id: "search.retry", message: "Retry" }),
  "search.noResults": msg({ id: "search.noResults", message: "No results for “{query}”." }),
  "search.resultCount": msg({ id: "search.resultCount", message: "{count} found for “{query}”." }),
} as const
