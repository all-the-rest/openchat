/**
 * Per-chat working files: the compact list, its actions and the quota line.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const files = {
  "files.title": msg({ id: "files.title", message: "Files" }),
  "files.listLabel": msg({ id: "files.listLabel", message: "Chat files" }),
  "files.loadFailed": msg({ id: "files.loadFailed", message: "The file list could not be loaded." }),
  "files.retry": msg({ id: "files.retry", message: "Retry" }),
  "files.origin.upload": msg({ id: "files.origin.upload", message: "Uploaded" }),
  "files.origin.agent": msg({ id: "files.origin.agent", message: "Agent" }),
  "files.download": msg({ id: "files.download", message: "Download" }),
  "files.downloadLabel": msg({ id: "files.downloadLabel", message: "Download {name}" }),
  "files.delete": msg({ id: "files.delete", message: "Delete" }),
  "files.deleteLabel": msg({ id: "files.deleteLabel", message: "Delete {name}" }),
  "files.quota": msg({ id: "files.quota", message: "{used} of {total} used ({percent}%)" }),
  "files.quotaLabel": msg({ id: "files.quotaLabel", message: "Chat file storage" }),
  "files.deleteTitle": msg({ id: "files.deleteTitle", message: "Delete this file?" }),
  "files.deleteBody": msg({ id: "files.deleteBody", message: "{name} will be removed from this chat. This cannot be undone." }),
  "files.deleteCancel": msg({ id: "files.deleteCancel", message: "Cancel" }),
  "files.deleteConfirm": msg({ id: "files.deleteConfirm", message: "Delete file" }),
  "files.deleteFailed": msg({ id: "files.deleteFailed", message: "The file could not be deleted." }),
  "files.dismiss": msg({ id: "files.dismiss", message: "Dismiss" }),
} as const
