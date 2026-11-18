import type { MemoryStatus, MemoryTrust } from "@openchat/contracts"
import type { MemoryAuditRecord } from "@openchat/contracts"
import type { MessageKey } from "../i18n/messages/en"

export const trustLabel: Record<MemoryTrust, MessageKey> = {
  explicit: "memory.trust.explicit",
  observed: "memory.trust.observed",
  inferred: "memory.trust.inferred",
}

export const statusLabel: Record<MemoryStatus, MessageKey> = {
  active: "memory.status.active",
  superseded: "memory.status.superseded",
  expired: "memory.status.expired",
  deleted: "memory.status.deleted",
}

export const auditLabel: Record<MemoryAuditRecord["action"], MessageKey> = {
  write: "memory.audit.write",
  update: "memory.audit.update",
  delete: "memory.audit.delete",
  prune: "memory.audit.prune",
}
