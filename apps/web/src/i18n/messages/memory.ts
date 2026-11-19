/**
 * `/memory` owner-override page.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const memory = {
  "nav.memory": msg({ id: "nav.memory", message: "Memory" }),
  "memory.title": msg({ id: "memory.title", message: "Memory" }),
  "memory.description": msg({
    id: "memory.description",
    message: "Facts the agent remembers about you. You have the final say.",
  }),
  "memory.loading": msg({ id: "memory.loading", message: "Loading memory…" }),
  "memory.loadFailed": msg({ id: "memory.loadFailed", message: "Memory could not be loaded." }),
  "memory.retry": msg({ id: "memory.retry", message: "Retry" }),
  "memory.empty": msg({ id: "memory.empty", message: "No memory facts yet." }),
  "memory.factsHeading": msg({ id: "memory.factsHeading", message: "Facts" }),
  "memory.auditHeading": msg({ id: "memory.auditHeading", message: "Audit" }),
  "memory.export": msg({ id: "memory.export", message: "Export JSON" }),
  "memory.col.id": msg({ id: "memory.col.id", message: "ID" }),
  "memory.col.kind": msg({ id: "memory.col.kind", message: "Kind" }),
  "memory.col.topic": msg({ id: "memory.col.topic", message: "Topic" }),
  "memory.col.status": msg({ id: "memory.col.status", message: "Status" }),
  "memory.col.trust": msg({ id: "memory.col.trust", message: "Trust" }),
  "memory.col.text": msg({ id: "memory.col.text", message: "Text" }),
  "memory.col.source": msg({ id: "memory.col.source", message: "Source" }),
  "memory.col.created": msg({ id: "memory.col.created", message: "Created" }),
  "memory.col.confirmed": msg({ id: "memory.col.confirmed", message: "Confirmed" }),
  "memory.col.actions": msg({ id: "memory.col.actions", message: "Actions" }),
  "memory.edit": msg({ id: "memory.edit", message: "Edit" }),
  "memory.cancel": msg({ id: "memory.cancel", message: "Cancel" }),
  "memory.save": msg({ id: "memory.save", message: "Save" }),
  "memory.delete": msg({ id: "memory.delete", message: "Delete" }),
  "memory.deleteConfirm": msg({ id: "memory.deleteConfirm", message: "Delete fact" }),
  "memory.deleteReasonLabel": msg({
    id: "memory.deleteReasonLabel",
    message: "Reason for deletion",
  }),
  "memory.deleteReasonPlaceholder": msg({
    id: "memory.deleteReasonPlaceholder",
    message: "Why is this fact no longer valid?",
  }),
  "memory.textLabel": msg({ id: "memory.textLabel", message: "Fact text" }),
  "memory.topicLabel": msg({ id: "memory.topicLabel", message: "Topic" }),
  "memory.saveFailed": msg({ id: "memory.saveFailed", message: "The fact could not be saved." }),
  "memory.deleteFailed": msg({
    id: "memory.deleteFailed",
    message: "The fact could not be deleted.",
  }),
  "memory.status.active": msg({ id: "memory.status.active", message: "Active" }),
  "memory.status.superseded": msg({ id: "memory.status.superseded", message: "Superseded" }),
  "memory.status.expired": msg({ id: "memory.status.expired", message: "Expired" }),
  "memory.status.deleted": msg({ id: "memory.status.deleted", message: "Deleted" }),
  "memory.trust.explicit": msg({ id: "memory.trust.explicit", message: "Explicit" }),
  "memory.trust.observed": msg({ id: "memory.trust.observed", message: "Observed" }),
  "memory.trust.inferred": msg({ id: "memory.trust.inferred", message: "Inferred" }),
  "memory.audit.actor": msg({ id: "memory.audit.actor", message: "Actor" }),
  "memory.audit.action": msg({ id: "memory.audit.action", message: "Action" }),
  "memory.audit.reason": msg({ id: "memory.audit.reason", message: "Reason" }),
  "memory.audit.time": msg({ id: "memory.audit.time", message: "Time" }),
  "memory.audit.fact": msg({ id: "memory.audit.fact", message: "Fact" }),
  "memory.audit.empty": msg({ id: "memory.audit.empty", message: "No changes recorded yet." }),
} as const
