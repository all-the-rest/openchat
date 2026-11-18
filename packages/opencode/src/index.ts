import type {
  AgentInfo,
  AppSkill,
  AppServer,
  BackgroundJob,
  CompactionOutcome,
  CompactionReason,
  EventEnvelope,
  InboxEntry,
  Message,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  Schedule,
  ScheduleEnds,
  SearchHit,
  SearchSource,
  ServerInfo,
  SessionContext,
  SessionInfo,
} from "@openchat/contracts"

export { BackendError } from "./errors"
export type { BackendErrorCode } from "./errors"
export {
  mapScheduleError,
  normalizeJob,
  normalizeSchedule,
  scheduleWhen,
} from "./live-tasks"

export interface PromptInput {
  text: string
  /** Optional client-generated id for the user message. */
  id?: string
  /**
   * `queue` accepts the prompt while a run is active and starts it when the
   * active run finishes. Without it a second prompt is rejected as `conflict`.
   */
  delivery?: "queue"
  /** Persisted model id; the live adapter applies it before the prompt. */
  model?: string
  /** Persisted agent id; the live adapter applies it before the prompt. */
  agent?: string
}

export interface CreateSessionInput {
  title?: string
  /** Absolute workspace directory; the browser never chooses this. */
  directory: string
}

export interface CreateScheduleInput {
  sessionID: string
  /** 1–4000 characters, validated by the route. */
  prompt: string
  /** One-shot end condition: fire after a duration or at an instant. */
  ends: ScheduleEnds
}

export interface SearchInput {
  /** Trimmed, validated by the route; 1–200 characters. */
  query: string
  /** Only these sources are queried. */
  sources: readonly SearchSource[]
  /** Per-source cap. */
  limit: number
}

export interface SearchOutcome {
  /** Sources this deployment can query, independent of `input.sources`. */
  available: SearchSource[]
  hits: SearchHit[]
  /** Sources that were requested but failed; the route reports them per group. */
  failed: SearchSource[]
}

/** One compaction call; the caller decides whether to wait for its end. */
export interface CompactOptions {
  /**
   * Idempotency key. A repeated id must not compact the session twice, so a
   * retried request and a racing one resolve to the first outcome.
   */
  id?: string
  /**
   * How long to wait for `session.compaction.ended` or `.failed`. Omitted or
   * zero returns as soon as the host accepted the request.
   */
  waitMs?: number
  /** Why the caller asked. The host decides its own reason in live mode. */
  reason?: CompactionReason
}

/** MCP servers and skills of the workspace, as one read of the host. */
export interface AppsSnapshot {
  servers: AppServer[]
  skills: AppSkill[]
}

export interface PromptResult {
  /**
   * Identifies the accepted prompt. The fake returns the assistant message id
   * for an immediate prompt and the user message id for a queued one; the live
   * adapter returns the OpenCode inbox entry id in both cases.
   */
  messageID: string
  /** True when the prompt was accepted into the queue of a running session. */
  queued?: boolean
}

/**
 * The single port the BFF talks to. The fake and the live adapter both
 * implement it. Permission and form methods are added when a milestone needs
 * them; keeping the surface small keeps both adapters honest.
 */
export interface ChatBackend {
  info(): Promise<ServerInfo>
  listSessions(): Promise<SessionInfo[]>
  createSession(input: CreateSessionInput): Promise<SessionInfo>
  listMessages(sessionID: string): Promise<Message[]>
  prompt(sessionID: string, input: PromptInput): Promise<PromptResult>
  /** Pending turns of a session, oldest first. */
  listInbox(sessionID: string): Promise<InboxEntry[]>
  /** Removes one pending turn; `messageID` is the id `prompt` returned. */
  cancelQueued(sessionID: string, messageID: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  listModels(): Promise<ModelInfo[]>
  listAgents(): Promise<AgentInfo[]>
  /** Outstanding permission requests of a session, oldest first. */
  listPermissions(sessionID: string): Promise<PermissionRequest[]>
  /** Answers one request. Throws `not_found` for an unknown request id. */
  replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void>
  /**
   * MCP servers and skills of the workspace. Throws a `BackendError` when the
   * host cannot answer the capability probe; one failing list must not hide
   * the other.
   */
  listApps(): Promise<AppsSnapshot>
  /** Connects one MCP server by its host-side name. */
  connectApp(name: string): Promise<void>
  disconnectApp(name: string): Promise<void>
  /** Grouped multi-source search; only `input.sources` are queried. */
  search(input: SearchInput): Promise<SearchOutcome>
  /**
   * Last reported token usage of a session and whether a run is active. One
   * host read, so a compaction decision cannot race two separate calls.
   */
  sessionContext(sessionID: string): Promise<SessionContext>
  /**
   * Requests compaction. Throws `conflict` while the session is streaming or a
   * compaction is already pending, and `not_found` for an unknown session.
   */
  compact(sessionID: string, options?: CompactOptions): Promise<CompactionOutcome>
  /** Schedules of one session; the host API requires a session id. */
  listSchedules(sessionID: string): Promise<Schedule[]>
  createSchedule(input: CreateScheduleInput): Promise<Schedule>
  pauseSchedule(id: string): Promise<Schedule>
  resumeSchedule(id: string): Promise<Schedule>
  deleteSchedule(id: string): Promise<void>
  /** Running and finished shell, subagent and image jobs, flat. */
  listJobs(): Promise<BackgroundJob[]>
  subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope>
}

export { isFakeScenario, resolveScenario } from "./scenarios"
export { FakeBackend } from "./fake"
export type { FakeBackendOptions, RecordedPrompt } from "./fake"
export type { CompactionRecord } from "./fake-compaction"
export { FakeHostSwitch } from "./fake-host"
export { LiveBackend } from "./live"
export type { LiveBackendOptions } from "./live"

/**
 * The `@opencode/client` range this BFF builds against: the major is pinned,
 * while minor and patch releases are adopted through a dependency PR that runs
 * the full CI. The lockfile decides the installed version. Keep this aligned
 * with `package.json`; `test/supported-major.test.ts` checks both.
 */
export const OPENCODE_CLIENT_RANGE = "^2.3.0"

const OPENCODE_CLIENT_RANGE_RE = /^\^(\d+)\.(\d+)\.(\d+)$/

/** The one `@opencode/client` major this BFF supports. Derived from the range. */
export const SUPPORTED_OPENCODE_MAJOR = Number(
  OPENCODE_CLIENT_RANGE_RE.exec(OPENCODE_CLIENT_RANGE)?.[1],
)

/** The `expectedVersion` value the API reports: the major as a string, e.g. "2". */
export const SUPPORTED_OPENCODE_MAJOR_LABEL = String(SUPPORTED_OPENCODE_MAJOR)

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/

/**
 * Whether an upstream version is on the supported major. The Code surface
 * warns on a major skew only: a 2.4.0 host next to a 2.3.0 client is healthy.
 */
export function matchesSupportedMajor(version: string): boolean {
  const major = VERSION_RE.exec(version)?.[1]
  return major !== undefined && Number(major) === SUPPORTED_OPENCODE_MAJOR
}
