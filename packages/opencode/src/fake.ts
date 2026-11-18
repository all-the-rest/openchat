import { EVENT } from "@openchat/contracts"
import type {
  AgentInfo,
  BackgroundJob,
  CompactionOutcome,
  EventEnvelope,
  FakeScenario,
  InboxEntry,
  Message,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  SearchSource,
  ServerInfo,
  SessionContext,
  SessionInfo,
} from "@openchat/contracts"
import { BackendError } from "./errors"
import type {
  AppsSnapshot,
  ChatBackend,
  CompactOptions,
  CreateSessionInput,
  PromptInput,
  PromptResult,
  SearchInput,
  SearchOutcome,
} from "./index"
import { FakeAppInventory } from "./fake-apps"
import { FAKE_MODELS, recordPrompt } from "./fake-completion"
import { FakeTaskStore } from "./fake-tasks"
import { FakeCompaction } from "./fake-compaction"
import { FakeEvents } from "./fake-events"
import { FakeRunner } from "./fake-runs"
import { FakePermissions } from "./fake-permissions"
import { fakeSearch } from "./fake-search"
import { clone, PartWriter } from "./fake-parts"
import type {
  FakeBackendOptions,
  QueuedPrompt,
  RecordedPrompt,
  RunState,
  SessionState,
} from "./fake-state"
import { subagentSeedSessions } from "./fake-seed"

export type { FakeBackendOptions, RecordedPrompt } from "./fake-state"

/** Deterministic in-memory backend; task methods come from `FakeTaskStore`. */
export class FakeBackend extends FakeTaskStore implements ChatBackend {
  private readonly sessions = new Map<string, SessionState>()
  private readonly runner: FakeRunner
  private readonly clock: () => number
  private readonly workspace: string
  private readonly version: string
  private readonly disabledSources: readonly SearchSource[]
  private readonly failingSources: readonly SearchSource[]
  private readonly apps: FakeAppInventory
  private readonly onAppAction?: (action: "connect" | "disconnect", name: string) => void
  private readonly events: FakeEvents
  private readonly permissions: FakePermissions
  private readonly compaction: FakeCompaction
  private readonly recorded = new Map<string, RecordedPrompt>()
  private readonly parts: PartWriter

  constructor(options: FakeBackendOptions = {}) {
    super({ now: options.now, jobs: options.seedJobs })
    this.clock = options.now ?? (() => Date.now())
    this.workspace = options.workspace ?? "/workspace"
    this.version = options.version ?? "0.1.0-fake"
    this.disabledSources = options.disabledSources ?? []
    this.failingSources = options.failingSources ?? []
    this.apps = new FakeAppInventory({ available: options.appsAvailable })
    this.onAppAction = options.onAppAction
    this.events = new FakeEvents(this.clock)
    this.compaction = new FakeCompaction({
      emit: (type, sid, data, durable) => this.events.emit(type, sid, data, durable),
      isStreaming: (sid) => this.runner.isStreaming(sid),
      usageTokens: options.usageTokens ?? 1_200,
      nextID: () => this.events.nextID("cmp"),
    })
    this.permissions = new FakePermissions((type, sid, data, durable) =>
      this.events.emit(type, sid, data, durable),
    )
    this.parts = new PartWriter({
      nextID: (prefix) => this.events.nextID(prefix),
      clock: () => this.clock(),
      emit: (type, sid, data, durable) => this.events.emit(type, sid, data, durable),
    })
    this.runner = new FakeRunner({
      emit: (type, sid, data, durable) => this.events.emit(type, sid, data, durable),
      nextID: () => this.events.nextID("msg"),
      clock: () => this.clock(),
      parts: this.parts,
      scenario: options.scenario ?? "default",
      delayMs: options.delayMs,
      messages: (sid) => this.requireSession(sid).messages,
      touch: (sid) => {
        this.requireSession(sid).info.updated = this.clock()
      },
      usage: (sid) => this.compaction.noteRun(sid),
    })
    if (options.seedSubagents) {
      for (const session of subagentSeedSessions(this.workspace, this.clock())) {
        this.sessions.set(session.info.id, session)
      }
    }
  }

  async info(): Promise<ServerInfo> {
    return { version: this.version, mode: "fake", workspace: this.workspace }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()]
      .map((session) => {
        const info = clone(session.info)
        const usage = this.compaction.usageOf(session.info.id)
        if (usage) info.usage = usage
        return info
      })
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

  async prompt(sessionID: string, input: PromptInput): Promise<PromptResult> {
    const session = this.requireSession(sessionID)
    recordPrompt(this.recorded, sessionID, input)
    const active = this.runner.isStreaming(sessionID)
    if (active && input.delivery !== "queue") {
      throw new BackendError("conflict", `Session ${sessionID} already has an active run`)
    }

    const userMessage = this.createUserMessage(sessionID, input)
    session.messages.push(userMessage)
    session.info.updated = userMessage.created

    if (active) {
      this.runner.enqueue(sessionID, {
        messageID: userMessage.id,
        text: input.text,
        created: userMessage.created,
      })
      // The assistant message waits for the active turn to end, keeping order.
      return { messageID: userMessage.id, queued: true }
    }

    const assistantMessage = this.runner.start(sessionID, input.text)
    return { messageID: assistantMessage.id }
  }

  async listInbox(sessionID: string): Promise<InboxEntry[]> {
    this.requireSession(sessionID)
    return this.runner.queued(sessionID).map((entry) => ({
      id: entry.messageID, sessionID, kind: "user", text: entry.text,
      delivery: "queue", created: entry.created,
    }))
  }

  async cancelQueued(sessionID: string, messageID: string): Promise<void> {
    const session = this.requireSession(sessionID)
    if (!this.runner.cancelQueued(sessionID, messageID)) {
      throw new BackendError("not_found", `Unknown queued message: ${messageID}`)
    }
    // A cancelled turn must not stay pinned as pending in the transcript.
    const messageIndex = session.messages.findIndex((message) => message.id === messageID)
    if (messageIndex !== -1) session.messages.splice(messageIndex, 1)
    this.events.emit(EVENT.inboxCancelled, sessionID, { sessionID, messageID }, true)
  }

  async interrupt(sessionID: string): Promise<void> {
    this.runner.interrupt(sessionID)
  }

  async listModels(): Promise<ModelInfo[]> {
    return FAKE_MODELS.map(clone)
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

  async sessionContext(sessionID: string): Promise<SessionContext> {
    this.requireSession(sessionID)
    return this.compaction.context(sessionID)
  }

  async compact(sessionID: string, options?: CompactOptions): Promise<CompactionOutcome> {
    this.requireSession(sessionID)
    return this.compaction.compact(sessionID, options)
  }

  /** Fake-mode probe: count, failures and the last reason. */
  compactionRecord(sessionID: string): ReturnType<FakeCompaction["record"]> {
    return this.compaction.record(sessionID)
  }

  /** Fake-mode control: reported usage before a turn has finished. */
  setContextUsage(sessionID: string, tokens: number): void {
    this.requireSession(sessionID)
    this.compaction.setUsage(sessionID, tokens)
  }

  /** Fake-mode control: the next `times` compactions fail. */
  failNextCompaction(sessionID: string, times = 1): void {
    this.requireSession(sessionID)
    this.compaction.failNext(sessionID, times)
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

}
