import type { MemoryFact, MemorySource, MemoryStatus, MemoryTrust } from "@openchat/contracts"
import type { MemoryErrorCode } from "./hygiene"

/** Public store shapes shared by the class, the BFF and the MCP tools. */

export interface MemoryWriteEntry {
  text: string
  topic: string
  tags?: string[]
  trust?: MemoryTrust
  source?: Partial<MemorySource>
  supersedes?: string[]
  expiresAt?: string | null
}

export interface MemoryUpdateEntry {
  id: string
  text?: string
  topic?: string
  tags?: string[]
  trust?: MemoryTrust
  status?: MemoryStatus
  expiresAt?: string | null
  confirm?: boolean
}

export type MemoryItemResult =
  | { ok: true; fact: MemoryFact }
  | { ok: false; id?: string; code: MemoryErrorCode; duplicateOf?: string }

export interface MemoryAuditEntry {
  at: string
  actor: string
  action: "write" | "update" | "delete" | "prune"
  ids: string[]
  reason: string
}

export type PruneReason = "stale" | "superseded" | "duplicate" | "oversized" | "over-budget"

export interface PruneCandidate {
  id: string
  topic: string
  reason: PruneReason
  lastConfirmedAt: string
}

export interface PruneResult {
  dryRun: boolean
  candidates: PruneCandidate[]
  deleted: string[]
}

export interface PruneOptions {
  dryRun?: boolean
  maxAgeDays?: number
  superseded?: boolean
  maxBytes?: number
}
