import { z } from "zod"

/** Roles that can appear in a transcript. */
export type Role = "user" | "assistant" | "system"

export type ToolStatus = "queued" | "running" | "success" | "error"

export interface TextPart {
  type: "text"
  id: string
  text: string
}

export interface ReasoningPart {
  type: "reasoning"
  id: string
  text: string
}

export interface ToolPart {
  type: "tool"
  id: string
  callID: string
  name: string
  status: ToolStatus
  input?: string
  output?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface ErrorPart {
  type: "error"
  id: string
  message: string
  code?: string
  retryable?: boolean
}

/** A produced artifact. No signed URL is persisted: the renderer re-reads it. */
export interface ArtifactPart {
  type: "artifact"
  id: string
  artifactID: string
  title: string
  /** MIME sniffed at write time; absent on legacy HTML documents. */
  mime?: string
}

/**
 * One collapsed compaction section. `started` opens the lifecycle, `ended` or
 * `failed` closes it with the summary or the failure reason (issue #53).
 * Host-provided text (`summary`, `message`) is data, not UI copy.
 */
export interface CompactionPart {
  type: "compaction"
  id: string
  status: "started" | "ended" | "failed"
  reason?: "auto" | "manual"
  summary?: string
  message?: string
  code?: string
  retryable?: boolean
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | ErrorPart
  | ArtifactPart
  | CompactionPart

export type MessageStatus = "streaming" | "complete" | "stopped" | "error"

export interface Message {
  id: string
  sessionID: string
  role: Role
  parts: Part[]
  created: number
  status: MessageStatus
}

export const toolPartSchema = z.object({
  type: z.literal("tool"),
  id: z.string(),
  callID: z.string(),
  name: z.string(),
  status: z.enum(["queued", "running", "success", "error"]),
  input: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
})

export const partSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), id: z.string(), text: z.string() }),
  z.object({ type: z.literal("reasoning"), id: z.string(), text: z.string() }),
  toolPartSchema,
  z.object({
    type: z.literal("error"),
    id: z.string(),
    message: z.string(),
    code: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("compaction"),
    id: z.string(),
    status: z.enum(["started", "ended", "failed"]),
    reason: z.enum(["auto", "manual"]).optional(),
    summary: z.string().optional(),
    message: z.string().optional(),
    code: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
])

export const messageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(partSchema),
  created: z.number(),
  status: z.enum(["streaming", "complete", "stopped", "error"]),
})

/** Plain text of a message, used for copy and for E2E assertions. */
export function messageText(message: Message): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}
