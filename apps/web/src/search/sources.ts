import type { SearchSource } from "@openchat/contracts"
import type { MessageKey } from "../i18n"

/** Source label keys; shared by the page toggles and the result groups. */
export const SOURCE_LABEL: Record<SearchSource, MessageKey> = {
  chats: "search.sourceChats",
  workspace: "search.sourceWorkspace",
  web: "search.sourceWeb",
  apps: "search.sourceApps",
}

/** Host status vocabulary; unknown values stay as the host sent them. */
export const STATUS_LABEL: Record<string, MessageKey> = {
  connected: "search.status.connected",
  pending: "search.status.pending",
  needs_auth: "search.status.needsAuth",
  failed: "search.status.failed",
  disabled: "search.status.disabled",
  available: "search.status.available",
}
