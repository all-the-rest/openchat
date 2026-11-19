/**
 * Command palette, chat export and the usage panel (issue #8, M6 polish).
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const polish = {
  "palette.trigger": msg({ id: "palette.trigger", message: "Open command palette" }),
  "palette.label": msg({ id: "palette.label", message: "Command palette" }),
  "palette.placeholder": msg({ id: "palette.placeholder", message: "Search commands and chats" }),
  "palette.groupActions": msg({ id: "palette.groupActions", message: "Actions" }),
  "palette.groupChats": msg({ id: "palette.groupChats", message: "Chats" }),
  "palette.groupRecent": msg({ id: "palette.groupRecent", message: "Recent chats" }),
  "palette.empty": msg({ id: "palette.empty", message: "No results" }),
  "palette.failed": msg({ id: "palette.failed", message: "Chat search failed" }),
  "palette.action.newChat": msg({ id: "palette.action.newChat", message: "New chat" }),
  "palette.action.chat": msg({ id: "palette.action.chat", message: "Go to chat" }),
  "palette.action.settings": msg({ id: "palette.action.settings", message: "Open settings" }),
  "palette.action.apps": msg({ id: "palette.action.apps", message: "Open apps" }),
  "palette.action.artifacts": msg({ id: "palette.action.artifacts", message: "Open artifacts" }),
  "palette.action.code": msg({ id: "palette.action.code", message: "Open code" }),
  "palette.action.theme": msg({ id: "palette.action.theme", message: "Switch theme" }),
  "palette.action.language": msg({ id: "palette.action.language", message: "Switch language" }),
  "palette.action.copyAnswer": msg({ id: "palette.action.copyAnswer", message: "Copy current answer" }),
  "palette.copyFailed": msg({ id: "palette.copyFailed", message: "The answer could not be copied." }),
  "palette.shortcut": msg({ id: "palette.shortcut", message: "Ctrl K" }),

  "export.action": msg({ id: "export.action", message: "Download chat" }),
  "export.menuLabel": msg({ id: "export.menuLabel", message: "Chat actions" }),
  "export.roleUser": msg({ id: "export.roleUser", message: "You" }),
  "export.roleAssistant": msg({ id: "export.roleAssistant", message: "Assistant" }),
  "export.roleSystem": msg({ id: "export.roleSystem", message: "System" }),
  "export.exportedOn": msg({ id: "export.exportedOn", message: "Exported {date}" }),
  "export.toolLine": msg({ id: "export.toolLine", message: "`{name}` — {status}" }),
  "export.artifactLine": msg({ id: "export.artifactLine", message: "`{name}` — {note}" }),
  "export.artifactNote": msg({ id: "export.artifactNote", message: "download link omitted; files live in the chat" }),
  "export.success": msg({ id: "export.success", message: "Chat downloaded as Markdown." }),
  "export.failed": msg({ id: "export.failed", message: "The chat could not be downloaded." }),

  "usage.label": msg({ id: "usage.label", message: "Usage" }),
  "usage.title": msg({ id: "usage.title", message: "Token usage" }),
  "usage.input": msg({ id: "usage.input", message: "Input" }),
  "usage.output": msg({ id: "usage.output", message: "Output" }),
  "usage.cached": msg({ id: "usage.cached", message: "Cached" }),
  "usage.context": msg({ id: "usage.context", message: "Context limit" }),
  "usage.notReported": msg({ id: "usage.notReported", message: "not reported" }),
  "usage.contextFill": msg({ id: "usage.contextFill", message: "Context used: {percent}" }),
} as const
