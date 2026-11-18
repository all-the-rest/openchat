import { z } from "zod"

import type { AppsSurfaceInfo } from "./apps"
import type { ArtifactsSurfaceInfo } from "./artifacts"

export * from "./apps"
export * from "./artifacts"
export * from "./artifacts/caps"

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

export type Part = TextPart | ReasoningPart | ToolPart | ErrorPart

export type MessageStatus = "streaming" | "complete" | "stopped" | "error"

export interface Message {
  id: string
  sessionID: string
  role: Role
  parts: Part[]
  created: number
  status: MessageStatus
}

export interface SessionInfo {
  id: string
  title: string
  directory: string
  created: number
  updated: number
}

export interface ModelInfo {
  id: string
  name: string
  providerID: string
}

export interface AgentInfo {
  id: string
  name: string
  description?: string
}

export interface ServerInfo {
  version: string
  mode: "fake" | "live"
  workspace: string
}

/**
 * State of the OpenCode host behind the BFF, not of the BFF itself: the BFF
 * answering at all proves that it is up, so only the host can be down.
 *
 * `reachable` is false when every host call failed. A host that answered one
 * call is up, so a partial failure keeps `reachable: true` and reports the
 * failed fragments as empty (`server: null`, `models: []`, `agents: []`).
 */
export interface HostStatus {
  reachable: boolean
}

export interface InfoResponse {
  host: HostStatus
  /** `null` when the host did not answer its info call. */
  server: ServerInfo | null
  models: ModelInfo[]
  agents: AgentInfo[]
  scenario: string
  dictation: DictationInfo
  code: CodeSurfaceInfo
  apps: AppsSurfaceInfo
  artifacts: ArtifactsSurfaceInfo
}

/**
 * Code surface availability, delivered with `/api/info` so the client can
 * hide the switch without a second request.
 */
export interface CodeSurfaceInfo {
  /** False when the deployment has no Code host; the UI must hide the switch. */
  configured: boolean
  /**
   * The supported `@opencode/client` major as a string, e.g. `"2"`. Any host on
   * `2.x.y` matches; a `3.x` host does not.
   */
  expectedVersion: string
}

/** Result of `GET /api/code/ticket`: a single-use entry URL. */
export interface CodeTicketResponse {
  /** Absolute Code-host URL with the single-use ticket and the `next` path. */
  url: string
}

/** Result of `GET /api/code/status`: reachability and version match. */
export interface CodeStatusResponse {
  configured: boolean
  /** Whether the Code host answered its `/__health` probe. */
  reachable: boolean
  /** The Code host's upstream version, when reachable. */
  version?: string
  /** The supported `@opencode/client` major, e.g. `"2"`. */
  expectedVersion: string
  /** True when `version` is on `expectedVersion`'s major; false when unreachable. */
  matches: boolean
}

/** Dictation availability and the limits the composer must respect. */
export interface DictationInfo {
  enabled: boolean
  maxSeconds: number
  maxBytes: number
}

/**
 * Result of one `POST /api/transcribe` call.
 */
export interface TranscriptionResponse {
  text: string
  durationMs: number
}

/** Sources `/api/search` can group by. */
export const SEARCH_SOURCES = ["chats", "workspace", "web", "apps"] as const
export type SearchSource = (typeof SEARCH_SOURCES)[number]

/** One search hit. Fields are set by the source that produced it. */
export interface SearchHit {
  source: SearchSource
  /** Stable within the source; used as the React key. */
  id: string
  title: string
  snippet?: string
  /** `chats`: the session and, when the match is in a message, that message. */
  sessionID?: string
  messageID?: string
  /** `workspace`: path relative to the workspace root. */
  path?: string
  /** `web`: citation and the provider that answered. */
  url?: string
  provider?: string
  published?: number
  /** `apps`: MCP server, tool or skill and its status. */
  app?: string
  /** `tool` is reserved: the pinned client cannot list a server's tools. */
  appKind?: "server" | "tool" | "skill"
  status?: string
}

/** `disabled`: not configured on the host, so it was not queried. */
export type SearchGroupState = "ok" | "failed" | "disabled"

export interface SearchGroup {
  source: SearchSource
  state: SearchGroupState
  /** Number of hits in this response; never more than the request limit. */
  total: number
  hits: SearchHit[]
}

export interface SearchResponse {
  query: string
  /** Sources this deployment can query; the client renders its toggles from it. */
  available: SearchSource[]
  groups: SearchGroup[]
}

export interface LoginResponse {
  user: string
}

export interface PromptResponse {
  ok: true
  messageID: string
  /** True when the prompt was accepted into the queue of a running session. */
  queued?: boolean
}

export interface PromptRequest {
  text: string
  /** `queue` accepts the prompt while a run is active instead of rejecting it. */
  delivery?: "queue"
}

/** Kind of a pending turn, mirroring the OpenCode inbox entry types. */
export type InboxEntryKind = "user" | "synthetic" | "compaction" | "move"

/**
 * One pending turn in a session's queue. `id` is the message id the prompt
 * response returned; cancel targets exactly that id.
 */
export interface InboxEntry {
  id: string
  sessionID: string
  kind: InboxEntryKind
  /** Prompt text for user and synthetic entries; empty for other kinds. */
  text: string
  delivery: "steer" | "queue"
  created: number
}

export interface InboxResponse {
  entries: InboxEntry[]
}

export interface CreateSessionRequest {
  title?: string
}

/** Event names the fake backend and the live adapter normalize to. */
export const EVENT = {
  sessionCreated: "session.created",
  executionStarted: "session.execution.started",
  executionSucceeded: "session.execution.succeeded",
  executionFailed: "session.execution.failed",
  textDelta: "session.text.delta",
  reasoningDelta: "session.reasoning.delta",
  toolUpdated: "session.tool.updated",
  messageCompleted: "session.message.completed",
  inboxEnqueued: "session.inbox.enqueued",
  inboxDelivered: "session.inbox.delivered",
  inboxCancelled: "session.inbox.cancelled",
  inboxDeliveryChanged: "session.inbox.delivery.changed",
  interrupted: "session.interrupted",
  usageUpdated: "session.usage.updated",
  error: "session.error",
} as const

export type EventType = (typeof EVENT)[keyof typeof EVENT]

export interface DurableRef {
  aggregateID: string
  seq: number
  version: number
}

export interface EventEnvelope {
  id: string
  created: number
  type: string
  data: Record<string, unknown>
  durable?: DurableRef
}

export interface TextDeltaData {
  sessionID: string
  messageID: string
  partID: string
  delta: string
}

export interface ReasoningDeltaData extends TextDeltaData {}

export interface ToolUpdatedData {
  sessionID: string
  messageID: string
  part: ToolPart
}

export interface ExecutionData {
  sessionID: string
  messageID: string
}

export interface SessionErrorData {
  sessionID: string
  messageID?: string
  message: string
  code?: string
  retryable?: boolean
}

/** Scripted fake scenarios; `rich` exercises the M2 renderers. */
export type FakeScenario =
  | "default"
  | "rich"
  | "reasoning"
  | "tools"
  | "error"
  | "abort"
  | "slow"

export const promptRequestSchema = z.object({
  text: z.string().min(1).max(32_000),
  /** `queue` accepts a prompt while a run is active instead of rejecting it. */
  delivery: z.literal("queue").optional(),
})

export const createSessionRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
})

export const loginRequestSchema = z.object({
  user: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

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
])

export const messageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(partSchema),
  created: z.number(),
  status: z.enum(["streaming", "complete", "stopped", "error"]),
})

export const eventEnvelopeSchema = z.object({
  id: z.string(),
  created: z.number(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  durable: z
    .object({ aggregateID: z.string(), seq: z.number(), version: z.number() })
    .optional(),
})

/** Plain text of a message, used for copy and for E2E assertions. */
export function messageText(message: Message): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}
