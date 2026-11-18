import { EVENT } from "@openchat/contracts"
import type {
  AgentInfo,
  BackgroundJob,
  EventEnvelope,
  FakeScenario,
  InboxEntry,
  Message,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  SearchSource,
  ServerInfo,
  SessionInfo,
} from "@openchat/contracts"
import { BackendError } from "./errors"
import type {
  AppsSnapshot,
  ChatBackend,
  CreateSessionInput,
  PromptInput,
  PromptResult,
  SearchInput,
  SearchOutcome,
} from "./index"
import { FakeAppInventory } from "./fake-apps"
import { FakeInstructions } from "./fake-instructions"
import { FakeTaskStore } from "./fake-tasks"
import { FakeEvents } from "./fake-events"
import { FakePermissions } from "./fake-permissions"
import { fakeSearch } from "./fake-search"
import { clone, errorText, PartWriter } from "./fake-parts"
import { resolveScenario, runScenario } from "./scenarios"
import type { FakeBackendOptions } from "./fake-types"

export type { FakeBackendOptions } from "./fake-types"
import type { ScenarioOutcome } from "./scenarios"

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

/** Last accepted prompt of a session, exposed through the fake-mode probe. */
export interface RecordedPrompt {
  text: string
  model?: string
  agent?: string
}

/** Deterministic in-memory backend; task methods come from `FakeTaskStore`. */
export class FakeBackend extends FakeTaskStore implements ChatBackend {
  private readonly sessions = new Map<string, SessionState>()
  private readonly runs = new Map<string, RunState>()
  /** One FIFO per session; entries are promoted when the active run ends. */
  private readonly queues = new Map<string, QueuedPrompt[]>()
  private readonly scenario: FakeScenario
  private readonly delayOverride?: number
  private readonly clock: () => number
  private readonly workspace: string
  private readonly version: string
  private readonly disabledSources: readonly SearchSource[]
  private readonly failingSources: readonly SearchSource[]
  private readonly apps: FakeAppInventory
  private readonly onAppAction?: (action: "connect" | "disconnect", name: string) => void
  private readonly instructionMaxBytes?: number
  private readonly events: FakeEvents
  private readonly permissions: FakePermissions
  private readonly recorded = new Map<string, RecordedPrompt>()
  private readonly instructions = new FakeInstructions()
  private readonly parts: PartWriter

  constructor(options: FakeBackendOptions = {}) {
    super({ now: options.now, jobs: options.seedJobs })
    this.scenario = options.scenario ?? "default"
    this.delayOverride = options.delayMs
    this.clock = options.now ?? (() => Date.now())
    this.workspace = options.workspace ?? "/workspace"
    this.version = options.version ?? "0.1.0-fake"
    this.disabledSources = options.disabledSources ?? []
    this.failingSources = options.failingSources ?? []
    this.apps = new FakeAppInventory({ available: options.appsAvailable })
    this.onAppAction = options.onAppAction
    this.instructionMaxBytes = options.instructionMaxBytes
    this.events = new FakeEvents(this.clock)
    this.permissions = new FakePermissions((type, sid, data, durable) =>
      this.events.emit(type, sid, data, durable),
    )
    this.parts = new PartWriter({
      nextID: (prefix) => this.events.nextID(prefix),
      clock: () => this.clock(),
      emit: (type, sid, data, durable) => this.events.emit(type, sid, data, durable),
    })
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
    // An empty title lets the UI render its own localized placeholder.
    const info: SessionInfo = {
      id: this.events.nextID("ses"), title: input.title?.trim() ?? "",
      directory: input.directory, created, updated: created,
    }
    this.sessions.set(info.id, { info, messages: [] })
    this.events.emit(EVENT.sessionCreated, info.id, {
      sessionID: info.id, title: info.title, directory: info.directory,
    }, true)
    return clone(info)
  }

  async listMessages(sessionID: string): Promise<Message[]> {
    return this.requireSession(sessionID).messages.map((message) => clone(message))
  }

  async putSessionInstruction(sessionID: string, key: string, value: string): Promise<void> {
    this.requireSession(sessionID)
    this.instructions.put(sessionID, key, value, this.instructionMaxBytes)
  }

  /** Fake-mode probe: the instruction entries currently attached to a session. */
  instructionEntries(sessionID: string): Record<string, string> | null {
    return this.instructions.entries(sessionID)
  }

  async prompt(sessionID: string, input: PromptInput): Promise<PromptResult> {
    const session = this.requireSession(sessionID)
    this.recorded.set(sessionID, { text: input.text, model: input.model, agent: input.agent })
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
      // The assistant message waits for the active turn to end, keeping order.
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
      id: entry.messageID, sessionID, kind: "user", text: entry.text,
      delivery: "queue", created: entry.created,
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
    // A cancelled turn must not stay pinned as pending in the transcript.
    const messageIndex = session.messages.findIndex((message) => message.id === messageID)
    if (messageIndex !== -1) session.messages.splice(messageIndex, 1)
    this.events.emit(EVENT.inboxCancelled, sessionID, { sessionID, messageID }, true)
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

  async listPermissions(sessionID: string): Promise<PermissionRequest[]> {
    this.requireSession(sessionID)
    return this.permissions.list(sessionID)
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void> {
    this.requireSession(sessionID)
    this.permissions.reply(sessionID, requestID, decision)
  }

  /** Fake-mode probe: the last accepted prompt, including model and agent. */
  recordedPrompt(sessionID: string): RecordedPrompt | undefined {
    return this.recorded.get(sessionID)
  }

  /** Fake-mode control: raises an approval the browser must answer. */
  askPermission(sessionID: string, tool: string, action: string, resources: readonly string[] = []): PermissionRequest {
    this.requireSession(sessionID)
    return this.permissions.ask(sessionID, tool, action, resources)
  }

  async listApps(): Promise<AppsSnapshot> {
    return this.apps.list()
  }

  async connectApp(name: string): Promise<void> {
    await this.apps.connect(name)
    this.onAppAction?.("connect", name)
  }

  async disconnectApp(name: string): Promise<void> {
    await this.apps.disconnect(name)
    this.onAppAction?.("disconnect", name)
  }

  async search(input: SearchInput): Promise<SearchOutcome> {
    const sessions = [...this.sessions.values()].map((session) => ({
      info: session.info, messages: session.messages,
    }))
    return fakeSearch(
      input, sessions, this.apps.searchOptions(this.disabledSources, this.failingSources),
    )
  }

  subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    return this.events.subscribe(signal)
  }

  protected override requireSession(sessionID: string): SessionState {
    const session = this.sessions.get(sessionID)
    if (!session) throw new BackendError("not_found", `Unknown session: ${sessionID}`)
    return session
  }

  private createUserMessage(sessionID: string, input: PromptInput): Message {
    return {
      id: input.id ?? this.events.nextID("msg"), sessionID, role: "user",
      parts: [{ type: "text", id: this.events.nextID("part"), text: input.text }],
      created: this.clock(), status: "complete",
    }
  }

  private createAssistantMessage(sessionID: string): Message {
    return {
      id: this.events.nextID("msg"), sessionID, role: "assistant", parts: [],
      created: this.clock(), status: "streaming",
    }
  }

  private startRun(sessionID: string, messageID: string, text: string): void {
    const scenario = resolveScenario(text, this.scenario)
    const delay = this.delayOverride ?? (scenario === "slow" ? 400 : 15)
    const run: RunState = { sessionID, messageID, cancelled: false }
    this.runs.set(sessionID, run)
    void this.run(run, scenario, delay).catch(() => {
      // The run already reports failures through events.
      this.runs.delete(sessionID)
      this.startNext(sessionID)
    })
  }

  /** Promotes the next queued prompt, if any, after a run ended. */
  private startNext(sessionID: string): void {
    const queue = this.queues.get(sessionID)
    const next = queue?.shift()
    if (!queue || !next) { this.queues.delete(sessionID); return }
    if (queue.length === 0) this.queues.delete(sessionID)
    const assistantMessage = this.createAssistantMessage(sessionID)
    this.requireSession(sessionID).messages.push(assistantMessage)
    this.startRun(sessionID, assistantMessage.id, next.text)
  }

  private findMessage(sessionID: string, messageID: string): Message {
    const message = this.requireSession(sessionID).messages.find((entry) => entry.id === messageID)
    if (!message) throw new BackendError("not_found", `Unknown message: ${messageID}`)
    return message
  }

  /** One scripted step; false means interrupted before or during the wait. */
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
    let outcome: ScenarioOutcome = "completed"

    this.events.emit(EVENT.executionStarted, run.sessionID, {
      sessionID: run.sessionID, messageID: message.id,
    }, true)

    try {
      outcome = await this.performScenario(run, message, scenario, delayMs)
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown fake backend error"
      this.parts.addError(run.sessionID, message, reason, "fake_error", false)
      outcome = "failed"
    }

    if (outcome === "completed") {
      message.status = "complete"
      this.completeMessage(run, message)
      this.events.emit(EVENT.executionSucceeded, run.sessionID, {
        sessionID: run.sessionID, messageID: message.id,
      }, true)
    } else if (outcome === "interrupted") {
      message.status = "stopped"
      this.events.emit(EVENT.interrupted, run.sessionID, {
        sessionID: run.sessionID, messageID: message.id,
      }, true)
      this.completeMessage(run, message)
    } else {
      message.status = "error"
      this.completeMessage(run, message)
      this.events.emit(EVENT.executionFailed, run.sessionID, {
        sessionID: run.sessionID, messageID: message.id,
        message: errorText(message) ?? "The fake backend failed",
        code: "fake_error", retryable: false,
      }, true)
    }

    this.runs.delete(run.sessionID)
    this.startNext(run.sessionID)
  }

  private performScenario(
    run: RunState, message: Message, scenario: FakeScenario, delayMs: number,
  ): Promise<ScenarioOutcome> {
    const sid = run.sessionID
    return runScenario({
      pause: () => this.pause(run, delayMs),
      addTextPart: () => this.parts.addText(message),
      addReasoningPart: () => this.parts.addReasoning(message),
      addToolPart: (name, input) => this.parts.addTool(message, name, input),
      streamText: (partID, delta) => this.parts.streamText(sid, message, partID, delta),
      streamReasoning: (partID, delta) => this.parts.streamReasoning(sid, message, partID, delta),
      emitTool: (part, patch) => this.parts.emitTool(sid, message, part, patch),
      addErrorPart: (text, code, retryable) => this.parts.addError(sid, message, text, code, retryable),
    }, scenario)
  }

  private completeMessage(run: RunState, message: Message): void {
    const session = this.requireSession(run.sessionID)
    session.info.updated = this.clock()
    this.events.emit(EVENT.messageCompleted, run.sessionID, {
      sessionID: run.sessionID, messageID: message.id, message: clone(message),
    }, true)
  }
}
