import { z } from "zod"

/**
 * Agent memory (design: `docs/architecture/08-memory.md` §6, research:
 * `docs/research/agent-memory.md` "Recommended v1"). A file-first,
 * provenance-carrying fact store behind one batch-shaped internal route.
 * Every user-visible string stays in i18n; memory text is untrusted data.
 */

/** The breadth dimensions of the fact store. One append-only store holds them all. */
export const MEMORY_KINDS = [
  "preference",
  "profile",
  "project",
  "decision",
  "episode",
  "snippet",
] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** How a fact was learned. Only explicit confirmation renews the TTL. */
export const MEMORY_TRUST = ["explicit", "observed", "inferred"] as const
export type MemoryTrust = (typeof MEMORY_TRUST)[number]

/** Lifecycle of a fact. Non-active rows are reachable by `get`, not `find`. */
export const MEMORY_STATUS = ["active", "superseded", "expired", "deleted"] as const
export type MemoryStatus = (typeof MEMORY_STATUS)[number]

/** Key of the injected instruction entry (slash-free per the host key regex). */
export const MEMORY_INDEX_KEY = "memory.index"

/** Hard cap of the push layer, in estimated tokens. */
export const MEMORY_INDEX_MAX_TOKENS = 400

/** Provenance of a fact. All timestamps are ISO 8601 UTC strings. */
export interface MemorySource {
  sessionID?: string
  messageID?: string
  at?: string
}

/** One atomic fact as stored in `facts.jsonl`; `checksum` covers all other fields. */
export interface MemoryFact {
  id: string
  kind: MemoryKind
  text: string
  topic: string
  tags: string[]
  source: MemorySource
  trust: MemoryTrust
  status: MemoryStatus
  supersedes: string[]
  createdAt: string
  lastConfirmedAt: string
  expiresAt?: string
  checksum: string
}

/** One append-only line of `audit.jsonl`; a reason explains every mutation. */
export interface MemoryAuditEntry {
  at: string
  actor: string
  action: "write" | "update" | "delete" | "prune" | "corrupt"
  reason: string
  ids: string[]
}

/** Compact pull result from `find` (and prune candidates, with `reason`). */
export interface MemoryFindRow {
  id: string
  kind: MemoryKind
  topic: string
  text: string
  score: number
  createdAt: string
  /** Populated on prune candidates to explain why a row was selected. */
  reason?: string
}

/** Counts and ages for the memory surface. */
export interface MemoryStats {
  facts: number
  active: number
  superseded: number
  expired: number
  deleted: number
  bytes: number
  oldestActiveDays: number
}

/** A new fact; the store fills in id, timestamps, status and checksum. */
export interface MemoryWriteInput {
  kind: MemoryKind
  text: string
  topic: string
  tags?: string[]
  trust?: MemoryTrust
  source?: MemorySource
  expiresAt?: string
}

/** An edit to an existing fact. `confirm` renews the TTL without changing text. */
export interface MemoryUpdateInput {
  id: string
  text?: string
  topic?: string
  tags?: string[]
  trust?: MemoryTrust
  status?: MemoryStatus
  confirm?: boolean
  supersedes?: string[]
}

/** Result of regenerating the derived push layer. */
export interface MemoryIndexResult {
  index: string
  entries: number
  dropped: number
}

/** Body of `POST /internal/memory`: one operation, batch-shaped where writes are. */
export type MemoryOp =
  | { op: "index" }
  | { op: "find"; queries: string[]; tags?: string[]; since?: string; limit?: number }
  | { op: "get"; ids: string[]; fields?: string[] }
  | { op: "write"; inputs: MemoryWriteInput[]; actor: string }
  | { op: "update"; updates: MemoryUpdateInput[]; actor: string }
  | { op: "delete"; ids: string[]; reason: string; actor: string }
  | {
      op: "prune"
      dryRun: boolean
      maxAgeDays?: number
      superseded?: boolean
      maxBytes?: number
      actor: string
    }
  | { op: "stats" }

/** Compact, JSON-safe response of a memory operation. No raw store dump. */
export interface MemoryOpResult {
  ok: boolean
  error?: string
  ids?: string[]
  facts?: MemoryFact[]
  rows?: MemoryFindRow[]
  index?: string
  entries?: number
  dropped?: number
  candidates?: MemoryFindRow[]
  removed?: string[]
  stats?: MemoryStats
}

/** Validates the write boundary before anything reaches the store. */
export const memoryWriteInputSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  text: z.string(),
  topic: z.string(),
  tags: z.array(z.string()).optional(),
  trust: z.enum(MEMORY_TRUST).optional(),
  source: z
    .object({
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      at: z.string().optional(),
    })
    .optional(),
  expiresAt: z.string().optional(),
})

/** Validates a batch edit; content fields are optional so confirmation is cheap. */
export const memoryUpdateInputSchema = z.object({
  id: z.string().min(1),
  text: z.string().optional(),
  topic: z.string().optional(),
  tags: z.array(z.string()).optional(),
  trust: z.enum(MEMORY_TRUST).optional(),
  status: z.enum(MEMORY_STATUS).optional(),
  confirm: z.boolean().optional(),
  supersedes: z.array(z.string()).optional(),
})
