/** Data model of the file-first, agent-managed memory store. */

export type MemoryTrust = "explicit" | "observed" | "inferred"
export type MemoryStatus = "active" | "superseded" | "expired" | "deleted"

export interface MemorySource {
  sessionID: string
  messageID: string
  /** ISO-8601 instant of the turn that produced the fact. */
  at: string
}

/** One atomic fact, stored as one line of `facts.jsonl`. */
export interface MemoryFact {
  id: string
  text: string
  topic: string
  tags: string[]
  source: MemorySource
  trust: MemoryTrust
  status: MemoryStatus
  supersedes: string[]
  createdAt: string
  lastConfirmedAt: string
  expiresAt: string
  /** SHA-256 of the canonical fact without this field. */
  checksum: string
}

export type MemoryAuditAction =
  | "write"
  | "update"
  | "delete"
  | "prune"
  | "expire"
  | "supersede"

/** Append-only record of every mutation, so a bad prune can be replayed. */
export interface MemoryAuditEntry {
  at: string
  actor: string
  action: MemoryAuditAction
  ids: string[]
  reason: string
}

export interface MemoryStats {
  total: number
  active: number
  superseded: number
  expired: number
  deleted: number
  bytes: number
  topics: number
}

/** Stable rejection codes shared by the BFF error mapping and the MCP tool. */
export type MemoryRejectCode =
  | "secret"
  | "instruction"
  | "invalid"
  | "too-large"
  | "capacity"
  | "duplicate"
  | "unknown"

export interface FactDraft {
  text: string
  topic: string
  tags?: string[]
  source?: MemorySource
  trust?: MemoryTrust
  /** Caller-supplied stable id; generated when absent. */
  id?: string
  createdAt?: string
  expiresAt?: string
}

export interface UpdateSpec {
  id: string
  text?: string
  topic?: string
  tags?: string[]
  trust?: MemoryTrust
  status?: MemoryStatus
  /** Explicit confirmation resets the TTL clock; retrieval never does. */
  confirm?: boolean
  expiresAt?: string
  reason?: string
}

export type WriteOutcome =
  | { ok: true; id: string }
  | { ok: false; code: MemoryRejectCode; message: string; duplicateOf?: string }

export type UpdateOutcome =
  | { ok: true; id: string; status: MemoryStatus }
  | { ok: false; code: MemoryRejectCode; message: string }

export type DeleteOutcome =
  | { ok: true; id: string }
  | { ok: false; code: MemoryRejectCode; message: string }

export type PruneReason = "stale" | "superseded" | "duplicate" | "oversized"

export interface PruneCandidate {
  id: string
  reason: PruneReason
  text: string
  topic: string
  ageDays: number
}

export interface PruneOptions {
  /** Never mutates unless explicitly false. */
  dryRun?: boolean
  maxAgeDays?: number
  superseded?: boolean
  maxBytes?: number
}

export interface PruneResult {
  dryRun: boolean
  candidates: PruneCandidate[]
  applied: string[]
}

export interface FindOptions {
  queries: string[]
  tags?: string[]
  since?: string
  limit?: number
  fields?: string[]
}

export interface FindRow {
  id: string
  text: string
  topic: string
  tags: string[]
  trust: MemoryTrust
  createdAt: string
  lastConfirmedAt: string
  score: number
}

export interface MemoryExport {
  version: 1
  exportedAt: string
  facts: MemoryFact[]
}
