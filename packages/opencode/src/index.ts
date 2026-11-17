import type {
  AgentInfo,
  EventEnvelope,
  InboxEntry,
  Message,
  ModelInfo,
  ServerInfo,
  SessionInfo,
} from "@openchat/contracts"

export { BackendError } from "./errors"
export type { BackendErrorCode } from "./errors"

export interface PromptInput {
  text: string
  /** Optional client-generated id for the user message. */
  id?: string
  /**
   * `queue` accepts the prompt while a run is active and starts it when the
   * active run finishes. Without it a second prompt is rejected as `conflict`.
   */
  delivery?: "queue"
}

export interface CreateSessionInput {
  title?: string
  /** Absolute workspace directory; the browser never chooses this. */
  directory: string
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
  subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope>
}

export { isFakeScenario, resolveScenario } from "./scenarios"
export { FakeBackend } from "./fake"
export type { FakeBackendOptions } from "./fake"
export { LiveBackend } from "./live"
export type { LiveBackendOptions } from "./live"
