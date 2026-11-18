import { z } from "zod"

/**
 * Context compaction: the token accounting the host reports, the notices the
 * transcript renders and the outcome one compaction call returns (spec 27).
 */

/**
 * Body of `POST /api/sessions/:id/compact`. The host types the idempotency key
 * as a message id, so the prefix is part of the contract; a missing key lets
 * the host mint one.
 */
export const compactRequestSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^msg_[A-Za-z0-9_-]{1,80}$/)
    .optional(),
})
export type CompactRequest = z.infer<typeof compactRequestSchema>

/** Token counts a host reports for one assistant turn. */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

/**
 * Prompt tokens that occupy the context window. Output and reasoning are
 * generated after the prompt is admitted, so they do not add to its size.
 */
export function contextTokens(usage: TokenUsage): number {
  return (
    Math.max(0, usage.input) +
    Math.max(0, usage.cache.read) +
    Math.max(0, usage.cache.write)
  )
}

/** Why the host compacted: its own policy or an explicit request. */
export type CompactionReason = "auto" | "manual"

/** One compaction attempt, as the transcript sees it. */
export interface CompactionNotice {
  id: string
  sessionID: string
  reason: CompactionReason
  status: "started" | "ended" | "failed"
  /** The host's summary text, when `session.compaction.ended` carried one. */
  summary?: string
  /** The host's failure reason, when `session.compaction.failed` carried one. */
  error?: string
  created: number
}

/**
 * What one compaction call achieved. `accepted` means the host queued the
 * request and the caller waits on events; `timeout` means the wait elapsed
 * without a terminal event, which is a warning, never a blocked turn.
 */
export type CompactionOutcomeStatus = "accepted" | "ended" | "failed" | "timeout"

export interface CompactionOutcome {
  status: CompactionOutcomeStatus
  /** The host's compaction id, when it returned one. */
  id?: string
  summary?: string
  error?: string
}

/** Last reported context of a session: usage and whether a run is active. */
export interface SessionContext {
  usage: TokenUsage | null
  streaming: boolean
}

/** Synthetic notices a prompt response can carry after an automatic compaction. */
export type PromptNotice = "contextCompacted" | "contextCompactionFailed"
