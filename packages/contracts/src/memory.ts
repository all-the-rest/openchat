/**
 * Wire contract for the BFF's memory surface. The record types come from the
 * shared store so the browser and the store cannot drift; only the request
 * shapes and response envelopes live here.
 */
import { z } from "zod"

export type {
  MemoryAuditEntry,
  MemoryFact,
  MemoryExport,
  MemoryStats,
  MemoryStatus,
  MemoryTrust,
} from "@openchat/memory-store"

export interface MemoryListResponse {
  facts: MemoryFact[]
  stats: MemoryStats
}

export interface MemoryIndexResponse {
  index: string
  tokens: number
}

export interface MemoryAuditResponse {
  entries: MemoryAuditEntry[]
}

const sourceSchema = z.object({
  sessionID: z.string().min(1).max(200),
  messageID: z.string().min(1).max(200),
  at: z.string().min(1).max(200),
})

export const memoryCreateSchema = z.object({
  text: z.string().min(1).max(4096),
  topic: z.string().min(1).max(128),
  tags: z.array(z.string().min(1).max(64)).max(16).optional(),
  trust: z.enum(["explicit", "observed", "inferred"]).optional(),
  source: sourceSchema.optional(),
  id: z.string().min(1).max(64).optional(),
  expiresAt: z.string().min(1).max(64).optional(),
})

export const memoryUpdateSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(4096).optional(),
  topic: z.string().min(1).max(128).optional(),
  tags: z.array(z.string().min(1).max(64)).max(16).optional(),
  trust: z.enum(["explicit", "observed", "inferred"]).optional(),
  status: z.enum(["active", "superseded", "expired", "deleted"]).optional(),
  confirm: z.boolean().optional(),
  expiresAt: z.string().min(1).max(64).optional(),
  reason: z.string().min(1).max(500).optional(),
})

export const memoryDeleteSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(100),
  reason: z.string().min(1).max(500),
})

export type MemoryCreateRequest = z.infer<typeof memoryCreateSchema>
export type MemoryUpdateRequest = z.infer<typeof memoryUpdateSchema>
export type MemoryDeleteRequest = z.infer<typeof memoryDeleteSchema>
