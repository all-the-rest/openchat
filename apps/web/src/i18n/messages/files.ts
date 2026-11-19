/**
 * Per-chat working files panel.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const files = {
  "files.title": msg({ id: "files.title", message: "Files" }),
  "files.loading": msg({ id: "files.loading", message: "Loading files…" }),
  "files.loadFailed": msg({ id: "files.loadFailed", message: "Files could not be loaded." }),
  "files.retry": msg({ id: "files.retry", message: "Retry" }),
  "files.empty": msg({ id: "files.empty", message: "No files in this chat yet." }),
  "files.meta": msg({ id: "files.meta", message: "{size} · {origin} · {date}" }),
  "files.originUpload": msg({ id: "files.originUpload", message: "Uploaded" }),
  "files.originAgent": msg({ id: "files.originAgent", message: "Agent" }),
  "files.download": msg({ id: "files.download", message: "Download" }),
  "files.downloadFile": msg({ id: "files.downloadFile", message: "Download {name}" }),
  "files.downloadFailed": msg({ id: "files.downloadFailed", message: "The file could not be downloaded." }),
  "files.delete": msg({ id: "files.delete", message: "Delete" }),
  "files.deleteFile": msg({ id: "files.deleteFile", message: "Delete {name}" }),
  "files.deleteConfirmTitle": msg({ id: "files.deleteConfirmTitle", message: "Delete this file?" }),
  "files.deleteConfirmBody": msg({ id: "files.deleteConfirmBody", message: "“{name}” will be removed from this chat. This cannot be undone." }),
  "files.deleteConfirm": msg({ id: "files.deleteConfirm", message: "Delete" }),
  "files.cancel": msg({ id: "files.cancel", message: "Cancel" }),
  "files.deleteFailed": msg({ id: "files.deleteFailed", message: "The file could not be deleted." }),
  "files.quota": msg({ id: "files.quota", message: "{used} of {total}" }),
  "files.quotaLabel": msg({ id: "files.quotaLabel", message: "Storage used in this chat" }),
} as const
