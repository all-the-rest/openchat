/**
 * Durable owner memory (`/memory`). Explicit ids keep `t("key")` stable; the
 * German text lives in `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const memory = {
  "memory.title": msg({ id: "memory.title", message: "Memory" }),
  "memory.description": msg({
    id: "memory.description",
    message: "Durable facts the agent keeps across sessions. It writes and prunes them; you keep the last word.",
  }),
  "memory.loading": msg({ id: "memory.loading", message: "Loading memory…" }),
  "memory.loadFailed": msg({ id: "memory.loadFailed", message: "Memory could not be loaded." }),
  "memory.retry": msg({ id: "memory.retry", message: "Retry" }),
  "memory.count": msg({
    id: "memory.count",
    message: "{count, plural, one {# active fact} other {# active facts}}",
  }),
  "memory.search.label": msg({ id: "memory.search.label", message: "Search memory" }),
  "memory.search.placeholder": msg({
    id: "memory.search.placeholder",
    message: "Filter by text, topic or tag",
  }),
  "memory.search.empty": msg({
    id: "memory.search.empty",
    message: "No fact matches this filter.",
  }),
  "memory.empty": msg({
    id: "memory.empty",
    message: "No facts yet. The agent adds one when it learns something durable, or add one here.",
  }),
  "memory.trust.explicit": msg({ id: "memory.trust.explicit", message: "Explicit" }),
  "memory.trust.observed": msg({ id: "memory.trust.observed", message: "Observed" }),
  "memory.trust.inferred": msg({ id: "memory.trust.inferred", message: "Inferred" }),
  "memory.status.active": msg({ id: "memory.status.active", message: "Active" }),
  "memory.status.superseded": msg({ id: "memory.status.superseded", message: "Superseded" }),
  "memory.status.expired": msg({ id: "memory.status.expired", message: "Expired" }),
  "memory.status.deleted": msg({ id: "memory.status.deleted", message: "Deleted" }),
  "memory.fact.created": msg({ id: "memory.fact.created", message: "Added {when}" }),
  "memory.fact.confirmed": msg({
    id: "memory.fact.confirmed",
    message: "Confirmed {when}",
  }),
  "memory.fact.expires": msg({ id: "memory.fact.expires", message: "Expires {when}" }),
  "memory.fact.source": msg({ id: "memory.fact.source", message: "Open source session" }),
  "memory.fact.edit": msg({ id: "memory.fact.edit", message: "Edit {topic}" }),
  "memory.fact.save": msg({ id: "memory.fact.save", message: "Save" }),
  "memory.fact.cancel": msg({ id: "memory.fact.cancel", message: "Cancel" }),
  "memory.fact.delete": msg({ id: "memory.fact.delete", message: "Delete {topic}" }),
  "memory.fact.deleteConfirm": msg({
    id: "memory.fact.deleteConfirm",
    message: "Delete this fact? The audit keeps the reason.",
  }),
  "memory.fact.deleteReason": msg({
    id: "memory.fact.deleteReason",
    message: "Reason (required)",
  }),
  "memory.fact.deleteSubmit": msg({ id: "memory.fact.deleteSubmit", message: "Delete fact" }),
  "memory.fact.deleteCancel": msg({ id: "memory.fact.deleteCancel", message: "Keep fact" }),
  "memory.add.title": msg({ id: "memory.add.title", message: "Add a fact" }),
  "memory.add.text": msg({ id: "memory.add.text", message: "Fact" }),
  "memory.add.topic": msg({ id: "memory.add.topic", message: "Topic" }),
  "memory.add.topicPlaceholder": msg({
    id: "memory.add.topicPlaceholder",
    message: "For example, preference.language",
  }),
  "memory.add.trust": msg({ id: "memory.add.trust", message: "Trust" }),
  "memory.add.submit": msg({ id: "memory.add.submit", message: "Add fact" }),
  "memory.add.failed": msg({ id: "memory.add.failed", message: "The fact was not added. {reason}" }),
  "memory.edit.failed": msg({ id: "memory.edit.failed", message: "The fact was not saved. {reason}" }),
  "memory.delete.failed": msg({ id: "memory.delete.failed", message: "The fact was not deleted. {reason}" }),
  "memory.validation.required": msg({ id: "memory.validation.required", message: "Text and topic are required." }),
  "memory.validation.reason": msg({ id: "memory.validation.reason", message: "A reason is required." }),
  "memory.error.secret": msg({ id: "memory.error.secret", message: "Looks like a secret; remove the credential." }),
  "memory.error.instruction": msg({
    id: "memory.error.instruction",
    message: "Looks like an instruction; memory holds facts only.",
  }),
  "memory.error.duplicate": msg({ id: "memory.error.duplicate", message: "A near-identical fact already exists." }),
  "memory.error.invalid": msg({ id: "memory.error.invalid", message: "The fact is empty or too long." }),
  "memory.error.storeFull": msg({ id: "memory.error.storeFull", message: "The store is full; prune first." }),
  "memory.error.generic": msg({ id: "memory.error.generic", message: "The request failed." }),
  "memory.export": msg({ id: "memory.export", message: "Export JSON" }),
  "memory.index.title": msg({ id: "memory.index.title", message: "Index preview" }),
  "memory.index.hint": msg({
    id: "memory.index.hint",
    message: "This block is injected into each new session, capped at about 400 tokens.",
  }),
  "memory.index.tokens": msg({ id: "memory.index.tokens", message: "~{tokens} tokens" }),
  "memory.audit.title": msg({ id: "memory.audit.title", message: "Audit tail" }),
  "memory.audit.empty": msg({ id: "memory.audit.empty", message: "No changes recorded yet." }),
  "memory.audit.write": msg({ id: "memory.audit.write", message: "write" }),
  "memory.audit.update": msg({ id: "memory.audit.update", message: "update" }),
  "memory.audit.delete": msg({ id: "memory.audit.delete", message: "delete" }),
  "memory.audit.prune": msg({ id: "memory.audit.prune", message: "prune" }),
  "memory.audit.by": msg({ id: "memory.audit.by", message: "{action} by {actor}" }),
} as const
