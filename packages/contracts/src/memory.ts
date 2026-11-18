import { z } from "zod"

/**
 * Durable owner memory (issue #49). The store lives on disk in the workspace;
 * these types are the contract between the BFF, the MCP tool and the web UI.
 */

export const MEMORY_TRUSTS = ["explicit", "observed", "inferred"] as const
export const MEMORY_STATUSES = ["active", "superseded", "expired", "deleted"] as const

export type MemoryTrust = (typeof MEMORY_TRUSTS)[number]
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** Provenance: the session turn that produced the fact, when there was one. */
export interface MemorySource {
  sessionID: string
  messageID: string
  at: string
}

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
  expiresAt: string | null
  /** SHA-256 over the canonical fields; a mismatch reads as corrupt. */
  checksum: string
}

export interface MemoryStats {
  total: number
  active: number
  superseded: number
  expired: number
  deleted: number
  bytes: number
  totalBytesCap: number
  entryBytesCap: number
  topics: string[]
  indexChars: number
  indexTokens: number
}

export interface MemoryListResponse {
  facts: MemoryFact[]
  stats: MemoryStats
}

export interface MemoryIndexResponse {
  index: string
  chars: number
  tokens: number
}

export interface MemoryAuditRecord {
  at: string
  actor: string
  action: "write" | "update" | "delete" | "prune"
  ids: string[]
  reason: string
}

export interface MemoryAuditResponse {
  entries: MemoryAuditRecord[]
}

export interface MemoryExport {
  version: 1
  exportedAt: string
  facts: MemoryFact[]
}

export interface MemoryFactResponse {
  fact: MemoryFact
}

export const MEMORY_TEXT_MAX = 2_000
export const MEMORY_TOPIC_MAX = 80
export const MEMORY_TAG_MAX = 32
export const MEMORY_TAGS_MAX = 10
export const MEMORY_REASON_MAX = 500

const textSchema = z
  .string()
  .trim()
  .min(1, "text is required")
  .max(MEMORY_TEXT_MAX, `text must be at most ${MEMORY_TEXT_MAX} characters`)

const topicSchema = z
  .string()
  .trim()
  .min(1, "topic is required")
  .max(MEMORY_TOPIC_MAX, `topic must be at most ${MEMORY_TOPIC_MAX} characters`)
  .regex(/^[a-z0-9][a-z0-9._ -]*$/i, "topic must be a short label")

const tagsSchema = z
  .array(z.string().trim().min(1).max(MEMORY_TAG_MAX))
  .max(MEMORY_TAGS_MAX, `tags must contain at most ${MEMORY_TAGS_MAX} entries`)

const expiresSchema = z.string().datetime({ offset: true }).nullable()

export const memoryCreateSchema = z.object({
  text: textSchema,
  topic: topicSchema,
  tags: tagsSchema.default([]),
  trust: z.enum(MEMORY_TRUSTS).default("explicit"),
  source: z
    .object({
      sessionID: z.string().max(200).default(""),
      messageID: z.string().max(200).default(""),
    })
    .optional(),
  expiresAt: expiresSchema.optional(),
})

export type MemoryCreateRequest = z.infer<typeof memoryCreateSchema>

export const memoryUpdateSchema = z
  .object({
    text: textSchema.optional(),
    topic: topicSchema.optional(),
    tags: tagsSchema.optional(),
    trust: z.enum(MEMORY_TRUSTS).optional(),
    status: z.enum(MEMORY_STATUSES).optional(),
    expiresAt: expiresSchema.optional(),
    /** Explicit confirmation resets the TTL clock; a read never does. */
    confirm: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required")

export type MemoryUpdateRequest = z.infer<typeof memoryUpdateSchema>

export const memoryDeleteSchema = z.object({
  reason: z.string().trim().min(1, "reason is required").max(MEMORY_REASON_MAX),
})

export type MemoryDeleteRequest = z.infer<typeof memoryDeleteSchema>

export const EMPTY_MEMORY_STATS: MemoryStats = {
  total: 0,
  active: 0,
  superseded: 0,
  expired: 0,
  deleted: 0,
  bytes: 0,
  totalBytesCap: 0,
  entryBytesCap: 0,
  topics: [],
  indexChars: 0,
  indexTokens: 0,
}
