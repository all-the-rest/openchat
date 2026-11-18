/**
 * Artifact list and sandboxed viewer.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const artifacts = {
  "artifacts.title": msg({ id: "artifacts.title", message: "Artifacts" }),
  "artifacts.description": msg({ id: "artifacts.description", message: "HTML documents your agent has written. Each one runs sandboxed on a separate origin." }),
  "artifacts.loading": msg({ id: "artifacts.loading", message: "Loading artifacts…" }),
  "artifacts.loadFailed": msg({ id: "artifacts.loadFailed", message: "Artifacts could not be loaded." }),
  "artifacts.retry": msg({ id: "artifacts.retry", message: "Retry" }),
  "artifacts.emptyTitle": msg({ id: "artifacts.emptyTitle", message: "No artifacts yet" }),
  "artifacts.emptyBody": msg({ id: "artifacts.emptyBody", message: "An artifact appears here once the agent writes one with the app tool." }),
  "artifacts.listLabel": msg({ id: "artifacts.listLabel", message: "Artifacts" }),
  "artifacts.meta": msg({ id: "artifacts.meta", message: "{size} · {date}" }),
  "artifacts.open": msg({ id: "artifacts.open", message: "Open {title}" }),
  "artifacts.back": msg({ id: "artifacts.back", message: "Back to artifacts" }),
  "artifacts.viewerTitle": msg({ id: "artifacts.viewerTitle", message: "Artifact" }),
  "artifacts.viewerLoading": msg({ id: "artifacts.viewerLoading", message: "Loading artifact…" }),
  "artifacts.missingTitle": msg({ id: "artifacts.missingTitle", message: "Artifact not available" }),
  "artifacts.missingBody": msg({ id: "artifacts.missingBody", message: "It may have been deleted. The list shows what is still stored." }),
  "artifacts.errorTitle": msg({ id: "artifacts.errorTitle", message: "The artifact could not be loaded" }),
  "artifacts.errorBody": msg({ id: "artifacts.errorBody", message: "The app could not read this artifact. Try again." }),
  "artifacts.staleTitle": msg({ id: "artifacts.staleTitle", message: "This artifact link has expired" }),
  "artifacts.staleBody": msg({ id: "artifacts.staleBody", message: "The artifact host refused the link. Reload to request a fresh one." }),
  "artifacts.download": msg({ id: "artifacts.download", message: "Download" }),
  "artifacts.downloading": msg({ id: "artifacts.downloading", message: "Downloading…" }),
  "artifacts.downloadFailed": msg({ id: "artifacts.downloadFailed", message: "The download failed. Try again." }),
  "artifacts.refreshFailed": msg({ id: "artifacts.refreshFailed", message: "The artifact link could not be refreshed. Reload to get a fresh one." }),
  "artifacts.reload": msg({ id: "artifacts.reload", message: "Reload" }),
  "artifacts.present": msg({ id: "artifacts.present", message: "Present" }),
  "artifacts.exitPresent": msg({ id: "artifacts.exitPresent", message: "Exit present" }),
  "artifacts.presentRegion": msg({ id: "artifacts.presentRegion", message: "Presented artifact" }),
} as const
