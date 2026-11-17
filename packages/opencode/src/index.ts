import { EVENT } from "@openchat/contracts"
import type {
  AgentInfo,
  ErrorPart,
  EventEnvelope,
  FakeScenario,
  InboxEntry,
  Message,
  ModelInfo,
  ReasoningPart,
  ServerInfo,
  SessionInfo,
  TextPart,
  ToolPart,
} from "@openchat/contracts"
import { EventQueue } from "./events"
import { BackendError } from "./errors"

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

const SCENARIOS: FakeScenario[] = [
  "default",
  "rich",
  "reasoning",
  "tools",
  "error",
  "abort",
  "slow",
]

export function isFakeScenario(value: string): value is FakeScenario {
  return (SCENARIOS as string[]).includes(value)
}

/**
 * A prompt prefix selects a scenario for one turn, e.g. `rich: explain this`.
 * Otherwise the constructor scenario wins.
 */
export function resolveScenario(text: string, fallback: FakeScenario): FakeScenario {
  const match = /^(rich|reasoning|tools|error|slow):/.exec(text.trimStart())
  const name = match?.[1]
  return name && isFakeScenario(name) ? name : fallback
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

interface RunState {
  sessionID: string
  messageID: string
  cancelled: boolean
  wake?: () => void
}

interface SessionState {
  info: SessionInfo
  messages: Message[]
}

interface QueuedPrompt {
  /** Id of the queued user message; this is the inbox entry id. */
  messageID: string
  text: string
  created: number
}

export interface FakeBackendOptions {
  /** Scenario for prompts without a prefix. Defaults to `default`. */
  scenario?: FakeScenario
  /**
   * Delay between scripted chunks in milliseconds. Defaults to 15, or 400 for
   * the `slow` scenario. Tests pass 0.
   */
  delayMs?: number
  /** Injected clock for deterministic ids/timestamps. */
  now?: () => number
  workspace?: string
  version?: string
}

const DEFAULT_TEXT =
  "Hello from the deterministic fake backend. This answer streams as text deltas and finishes with a completed message."

const ABORT_TEXT =
  "Working through the requested steps in the fake backend. Each chunk is short so an interrupt can land between two deltas. Nothing here calls a provider or touches the network."

const ERROR_TEXT = "The provider failed before it could answer."

const REASONING_TEXT =
  "The user wants a deterministic answer. I will outline the structure, then stream the Markdown body, and finally report a tool call."

const RICH_MARKDOWN = [
  "## Fake backend overview",
  "",
  "This sample exercises the Markdown renderer with **bold text**, _italic text_, `inline code` and inline math $e^{i\\pi}$.",
  "",
  "- Sessions live in memory",
  "- Messages stream as deltas",
  "- Tool cards update in place",
  "",
  "| Part | Purpose | Rendered |",
  "| --- | --- | --- |",
  "| text | Markdown | yes |",
  "| tool | Status card | yes |",
  "",
  "> The fake backend is a product surface, not a test hack.",
  "",
  "```ts",
  "export function greet(name: string): string {",
  "  return `hello ${name}`",
  "}",
  "```",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "```mermaid",
  "flowchart LR",
  "  Prompt --> Backend",
  "  Backend --> Events",
  "  Events --> UI",
  "```",
].join("\n")

const TOOLS_TEXT = "Running two scripted tools: one succeeds, one fails."

const SLOW_TEXT = [
  "Slow scenario chunk one.",
  "Slow scenario chunk two.",
  "Slow scenario chunk three.",
  "Slow scenario chunk four.",
  "Slow scenario chunk five.",
  "Slow scenario chunk six.",
].join(" ")

/**
 * Deterministic in-memory backend. No HTTP, no provider, no clock except the
 * injected one. It emits the real envelope shape so normalization is tested.
 */
export class FakeBackend implements ChatBackend {
  private readonly sessions = new Map<string, SessionState>()
  private readonly runs = new Map<string, RunState>()
  /** One FIFO per session; entries are promoted when the active run ends. */
  private readonly queues = new Map<string, QueuedPrompt[]>()
  private readonly subscribers = new Set<EventQueue<EventEnvelope>>()
  private readonly scenario: FakeScenario
  private readonly delayOverride?: number
  private readonly clock: () => number
  private readonly workspace: string
  private readonly version: string
  private sessionCounter = 0
  private messageCounter = 0
  private partCounter = 0
  private callCounter = 0
  private eventCounter = 0
  private readonly durableCounters = new Map<string, number>()

  constructor(options: FakeBackendOptions = {}) {
    this.scenario = options.scenario ?? "default"
    this.delayOverride = options.delayMs
    this.clock = options.now ?? (() => Date.now())
    this.workspace = options.workspace ?? "/workspace"
    this.version = options.version ?? "0.1.0-fake"
  }

  async info(): Promise<ServerInfo> {
    return { version: this.version, mode: "fake", workspace: this.workspace }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()]
      .map((session) => clone(session.info))
      .sort((left, right) => left.created - right.created)
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const created = this.clock()
    const info: SessionInfo = {
      id: this.nextID("ses"),
      // An empty title lets the UI render its own localized placeholder.
      title: input.title?.trim() ?? "",
      directory: input.directory,
      created,
      updated: created,
    }
    this.sessions.set(info.id, { info, messages: [] })
    this.emit(EVENT.sessionCreated, info.id, {
      sessionID: info.id,
      title: info.title,
      directory: info.directory,
    }, true)
    return clone(info)
  }

  async listMessages(sessionID: string): Promise<Message[]> {
    return this.requireSession(sessionID).messages.map((message) => clone(message))
  }

  async prompt(sessionID: string, input: PromptInput): Promise<PromptResult> {
    const session = this.requireSession(sessionID)
    const active = this.runs.has(sessionID)
    if (active && input.delivery !== "queue") {
      throw new BackendError("conflict", `Session ${sessionID} already has an active run`)
    }

    const userMessage = this.createUserMessage(sessionID, input)
    session.messages.push(userMessage)
    session.info.updated = userMessage.created

    if (active) {
      const queue = this.queues.get(sessionID) ?? []
      queue.push({ messageID: userMessage.id, text: input.text, created: userMessage.created })
      this.queues.set(sessionID, queue)
      // The assistant message is created when the queued turn starts, so the
      // active turn is not touched and the transcript keeps its order.
      return { messageID: userMessage.id, queued: true }
    }

    const assistantMessage = this.createAssistantMessage(sessionID)
    session.messages.push(assistantMessage)
    this.startRun(sessionID, assistantMessage.id, input.text)
    return { messageID: assistantMessage.id }
  }

  async listInbox(sessionID: string): Promise<InboxEntry[]> {
    this.requireSession(sessionID)
    return (this.queues.get(sessionID) ?? []).map((entry) => ({
      id: entry.messageID,
      sessionID,
      kind: "user",
      text: entry.text,
      delivery: "queue",
      created: entry.created,
    }))
  }

  async cancelQueued(sessionID: string, messageID: string): Promise<void> {
    const session = this.requireSession(sessionID)
    const queue = this.queues.get(sessionID) ?? []
    const index = queue.findIndex((entry) => entry.messageID === messageID)
    if (index === -1) {
      throw new BackendError("not_found", `Unknown queued message: ${messageID}`)
    }
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(sessionID)
    // A cancelled turn disappears from the transcript too; otherwise the user
    // message would stay pinned as pending without a run behind it.
    const messageIndex = session.messages.findIndex((message) => message.id === messageID)
    if (messageIndex !== -1) session.messages.splice(messageIndex, 1)
    this.emit(EVENT.inboxCancelled, sessionID, { sessionID, messageID }, true)
  }

  async interrupt(sessionID: string): Promise<void> {
    const run = this.runs.get(sessionID)
    if (!run) return
    run.cancelled = true
    run.wake?.()
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "fake/echo", name: "Fake Echo", providerID: "fake" }]
  }

  async listAgents(): Promise<AgentInfo[]> {
    return [{ id: "build", name: "Build", description: "Deterministic scenario runner" }]
  }

  subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    const queue = new EventQueue<EventEnvelope>()
    const cleanup = () => {
      this.subscribers.delete(queue)
      queue.close()
    }
    if (signal?.aborted) {
      queue.close()
      return queue
    }
    this.subscribers.add(queue)
    signal?.addEventListener("abort", cleanup, { once: true })

    const iterator = queue[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => iterator.next(),
        return: async () => {
          cleanup()
          signal?.removeEventListener("abort", cleanup)
          await iterator.return?.()
          return { value: undefined, done: true }
        },
      }),
    }
  }

  private requireSession(sessionID: string): SessionState {
    const session = this.sessions.get(sessionID)
    if (!session) throw new BackendError("not_found", `Unknown session: ${sessionID}`)
    return session
  }

  private createUserMessage(sessionID: string, input: PromptInput): Message {
    return {
      id: input.id ?? this.nextID("msg"),
      sessionID,
      role: "user",
      parts: [{ type: "text", id: this.nextID("part"), text: input.text }],
      created: this.clock(),
      status: "complete",
    }
  }

  private createAssistantMessage(sessionID: string): Message {
    return {
      id: this.nextID("msg"),
      sessionID,
      role: "assistant",
      parts: [],
      created: this.clock(),
      status: "streaming",
    }
  }

  private startRun(sessionID: string, messageID: string, text: string): void {
    const scenario = resolveScenario(text, this.scenario)
    const delay = this.delayOverride ?? (scenario === "slow" ? 400 : 15)
    const run: RunState = { sessionID, messageID, cancelled: false }
    this.runs.set(sessionID, run)
    void this.run(run, scenario, delay).catch(() => {
      // A scripting failure must not become an unhandled rejection; the run
      // already reports failures through events.
      this.runs.delete(sessionID)
      this.startNext(sessionID)
    })
  }

  /** Promotes the next queued prompt, if any, after a run ended. */
  private startNext(sessionID: string): void {
    const queue = this.queues.get(sessionID)
    const next = queue?.shift()
    if (!queue || !next) {
      this.queues.delete(sessionID)
      return
    }
    if (queue.length === 0) this.queues.delete(sessionID)
    const assistantMessage = this.createAssistantMessage(sessionID)
    this.requireSession(sessionID).messages.push(assistantMessage)
    this.startRun(sessionID, assistantMessage.id, next.text)
  }

  private nextID(prefix: "ses" | "msg" | "part" | "call" | "evt"): string {
    switch (prefix) {
      case "ses":
        this.sessionCounter += 1
        return `ses_${this.sessionCounter}`
      case "msg":
        this.messageCounter += 1
        return `msg_${this.messageCounter}`
      case "part":
        this.partCounter += 1
        return `part_${this.partCounter}`
      case "call":
        this.callCounter += 1
        return `call_${this.callCounter}`
      case "evt":
        this.eventCounter += 1
        return `evt_${this.eventCounter}`
    }
  }

  private emit(
    type: string,
    sessionID: string,
    data: Record<string, unknown>,
    durable: boolean,
  ): EventEnvelope {
    const envelope: EventEnvelope = {
      id: this.nextID("evt"),
      created: this.clock(),
      type,
      data,
    }
    if (durable) {
      const seq = (this.durableCounters.get(sessionID) ?? 0) + 1
      this.durableCounters.set(sessionID, seq)
      envelope.durable = {
        aggregateID: sessionID,
        seq,
        version: 1,
      }
    }
    for (const subscriber of this.subscribers) subscriber.push(envelope)
    return envelope
  }

  private findMessage(sessionID: string, messageID: string): Message {
    const message = this.requireSession(sessionID).messages.find((entry) => entry.id === messageID)
    if (!message) throw new BackendError("not_found", `Unknown message: ${messageID}`)
    return message
  }

  private addTextPart(message: Message): TextPart {
    const part: TextPart = { type: "text", id: this.nextID("part"), text: "" }
    message.parts.push(part)
    return part
  }

  private addReasoningPart(message: Message): ReasoningPart {
    const part: ReasoningPart = { type: "reasoning", id: this.nextID("part"), text: "" }
    message.parts.push(part)
    return part
  }

  private addToolPart(message: Message, name: string, input: string): ToolPart {
    const part: ToolPart = {
      type: "tool",
      id: this.nextID("part"),
      callID: this.nextID("call"),
      name,
      status: "running",
      input,
      startedAt: this.clock(),
    }
    message.parts.push(part)
    return part
  }

  private streamText(run: RunState, message: Message, partID: string, delta: string): void {
    const part = message.parts.find((entry) => entry.id === partID)
    if (part?.type === "text") part.text += delta
    this.emit(EVENT.textDelta, run.sessionID, {
      sessionID: run.sessionID,
      messageID: message.id,
      partID,
      delta,
    }, false)
  }

  private streamReasoning(run: RunState, message: Message, partID: string, delta: string): void {
    const part = message.parts.find((entry) => entry.id === partID)
    if (part?.type === "reasoning") part.text += delta
    this.emit(EVENT.reasoningDelta, run.sessionID, {
      sessionID: run.sessionID,
      messageID: message.id,
      partID,
      delta,
    }, false)
  }

  private emitTool(run: RunState, message: Message, part: ToolPart, patch: Partial<ToolPart>): void {
    Object.assign(part, patch)
    if (patch.status === "success" || patch.status === "error") part.endedAt = this.clock()
    this.emit(EVENT.toolUpdated, run.sessionID, {
      sessionID: run.sessionID,
      messageID: message.id,
      part: clone(part),
    }, true)
  }

  /**
   * Waits for one scripted step. Returns false when the run was interrupted,
   * either before the wait or while it was sleeping.
   */
  private pause(run: RunState, delayMs: number): Promise<boolean> {
    if (run.cancelled) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (timer !== undefined) clearTimeout(timer)
        run.wake = undefined
        resolve(!run.cancelled)
      }
      run.wake = done
      timer = setTimeout(done, delayMs)
    })
  }

  private async run(run: RunState, scenario: FakeScenario, delayMs: number): Promise<void> {
    const message = this.findMessage(run.sessionID, run.messageID)
    let outcome: "completed" | "interrupted" | "failed" = "completed"

    this.emit(EVENT.executionStarted, run.sessionID, {
      sessionID: run.sessionID,
      messageID: message.id,
    }, true)

    try {
      outcome = await this.performScenario(run, message, scenario, delayMs)
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown fake backend error"
      this.addErrorPart(run, message, reason, "fake_error", false)
      outcome = "failed"
    }

    if (outcome === "completed") {
      message.status = "complete"
      this.completeMessage(run, message)
      this.emit(EVENT.executionSucceeded, run.sessionID, {
        sessionID: run.sessionID,
        messageID: message.id,
      }, true)
    } else if (outcome === "interrupted") {
      message.status = "stopped"
      this.emit(EVENT.interrupted, run.sessionID, {
        sessionID: run.sessionID,
        messageID: message.id,
      }, true)
      this.completeMessage(run, message)
    } else {
      message.status = "error"
      this.completeMessage(run, message)
      this.emit(EVENT.executionFailed, run.sessionID, {
        sessionID: run.sessionID,
        messageID: message.id,
        message: this.errorText(message) ?? "The fake backend failed",
        code: "fake_error",
        retryable: false,
      }, true)
    }

    this.runs.delete(run.sessionID)
    this.startNext(run.sessionID)
  }

  private async performScenario(
    run: RunState,
    message: Message,
    scenario: FakeScenario,
    delayMs: number,
  ): Promise<"completed" | "interrupted" | "failed"> {
    if (scenario === "error") {
      if (!(await this.pause(run, delayMs))) return "interrupted"
      this.addErrorPart(run, message, ERROR_TEXT, "provider_error", true)
      return "failed"
    }

    if (scenario === "rich") {
      const reasoningPart = this.addReasoningPart(message)
      for (const delta of chunkText(REASONING_TEXT, 24)) {
        if (!(await this.pause(run, delayMs))) return "interrupted"
        this.streamReasoning(run, message, reasoningPart.id, delta)
      }

      const textPart = this.addTextPart(message)
      for (const delta of chunkText(RICH_MARKDOWN, 48)) {
        if (!(await this.pause(run, delayMs))) return "interrupted"
        this.streamText(run, message, textPart.id, delta)
      }

      const tool = this.addToolPart(message, "read", "{\"path\":\"README.md\"}")
      this.emitTool(run, message, tool, { status: "running" })
      if (!(await this.pause(run, delayMs))) return "interrupted"
      this.emitTool(run, message, tool, { status: "success", output: "README contents" })
      return "completed"
    }

    if (scenario === "reasoning") {
      const reasoningPart = this.addReasoningPart(message)
      for (const delta of chunkText(REASONING_TEXT, 20)) {
        if (!(await this.pause(run, delayMs))) return "interrupted"
        this.streamReasoning(run, message, reasoningPart.id, delta)
      }
      const textPart = this.addTextPart(message)
      for (const delta of chunkText("Reasoning finished. Here is the answer.", 16)) {
        if (!(await this.pause(run, delayMs))) return "interrupted"
        this.streamText(run, message, textPart.id, delta)
      }
      return "completed"
    }

    if (scenario === "tools") {
      const textPart = this.addTextPart(message)
      for (const delta of chunkText(TOOLS_TEXT, 20)) {
        if (!(await this.pause(run, delayMs))) return "interrupted"
        this.streamText(run, message, textPart.id, delta)
      }

      const working = this.addToolPart(message, "bash", "{\"command\":\"pnpm test\"}")
      this.emitTool(run, message, working, { status: "running" })
      if (!(await this.pause(run, delayMs))) return "interrupted"
      this.emitTool(run, message, working, { status: "success", output: "tests passed" })

      const failing = this.addToolPart(message, "read", "{\"path\":\"missing.txt\"}")
      this.emitTool(run, message, failing, { status: "running" })
      if (!(await this.pause(run, delayMs))) return "interrupted"
      this.emitTool(run, message, failing, {
        status: "error",
        error: "File not found: missing.txt",
      })
      return "completed"
    }

    if (scenario === "slow") {
      const textPart = this.addTextPart(message)
      for (const delta of chunkText(SLOW_TEXT, 22)) {
        if (!(await this.pause(run, delayMs))) return "interrupted"
        this.streamText(run, message, textPart.id, delta)
      }
      return "completed"
    }

    if (scenario === "abort") {
      const textPart = this.addTextPart(message)
      for (const delta of chunkText(ABORT_TEXT, 18)) {
        if (!(await this.pause(run, delayMs))) return "interrupted"
        this.streamText(run, message, textPart.id, delta)
      }
      return "completed"
    }

    const textPart = this.addTextPart(message)
    for (const delta of chunkText(DEFAULT_TEXT, 16)) {
      if (!(await this.pause(run, delayMs))) return "interrupted"
      this.streamText(run, message, textPart.id, delta)
    }
    return "completed"
  }

  private addErrorPart(
    run: RunState,
    message: Message,
    text: string,
    code: string,
    retryable: boolean,
  ): void {
    const part: ErrorPart = {
      type: "error",
      id: this.nextID("part"),
      message: text,
      code,
      retryable,
    }
    message.parts.push(part)
    this.emit(EVENT.error, run.sessionID, {
      sessionID: run.sessionID,
      messageID: message.id,
      message: text,
      code,
      retryable,
      part: clone(part),
    }, true)
  }

  private errorText(message: Message): string | undefined {
    const part = message.parts.find((entry) => entry.type === "error")
    return part?.type === "error" ? part.message : undefined
  }

  private completeMessage(run: RunState, message: Message): void {
    const session = this.requireSession(run.sessionID)
    session.info.updated = this.clock()
    this.emit(EVENT.messageCompleted, run.sessionID, {
      sessionID: run.sessionID,
      messageID: message.id,
      message: clone(message),
    }, true)
  }
}

export { LiveBackend } from "./live"
export type { LiveBackendOptions } from "./live"
