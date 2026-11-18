import { OpenCode } from "@opencode/client"
import type {
  AgentInfo,
  BackgroundJob,
  EventEnvelope,
  InboxEntry,
  Message,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  Schedule,
  ServerInfo,
  SessionInfo,
} from "@openchat/contracts"
import type { OpenCodeClient, V2Event } from "@opencode/client"
import type {
  AppsSnapshot,
  ChatBackend,
  CreateScheduleInput,
  CreateSessionInput,
  PromptInput,
  PromptResult,
  SearchInput,
  SearchOutcome,
} from "./index"
import { EventQueue } from "./events"
import { BackendError } from "./errors"
import { liveAppAction, liveApps } from "./live-apps"
import { applyCompletion } from "./live-model"
import { normalizePermissionRequest, replyHostPermission } from "./live-permissions"
import { createToolEventState, normalizeEvent } from "./live-events"
import { mapScheduleError, normalizeJob, normalizeSchedule, scheduleWhen } from "./live-tasks"
import { liveSearch } from "./live-search"
import {
  liveCancelOAuth,
  liveCompleteOAuth,
  liveConnectKey,
  liveOAuthStatus,
  liveProviders,
  liveStartOAuth,
} from "./live-providers"
import type { ProviderAttemptInput, ProviderKeyInput, ProviderOAuthInput } from "./index"
import { normalizeMessage, normalizeSession } from "./live-normalize"

// The normalizers stay importable from this module; the BFF only needs the
// adapter, but tests exercise them next to it.
export { createToolEventState, normalizeEvent } from "./live-events"
export type { ToolEventState } from "./live-events"
export { normalizeMessage, normalizeSession } from "./live-normalize"

export interface LiveBackendOptions {
  baseUrl: string
  username?: string
  password: string
  workspace: string
  /** Injected client for tests; production builds one from `baseUrl`. */
  client?: OpenCodeClient
}

/**
 * Minimal base64 encoder. Node has `btoa`, but credentials may contain
 * non-Latin-1 characters, so encode UTF-8 first.
 */
function base64(value: string): string {
  let binary = ""
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Adapter for an OpenCode server that already runs at `OPENCODE_URL`; this
 * adapter never starts one itself. It typechecks against
 * `@opencode/client@2.3.0`; there is no live test in CI.
 */
export class LiveBackend implements ChatBackend {
  private readonly client: OpenCodeClient
  private readonly workspace: string
  /** Per-subscriber normalizer state is created in `subscribe`. */
  private readonly subscribers = new Set<EventQueue<V2Event>>()
  private upstream?: AsyncIterator<V2Event>
  /** modelID → providerID, warmed by `listModels` (the BFF's info call). */
  private modelProviders?: Map<string, string>

  constructor(options: LiveBackendOptions) {
    this.workspace = options.workspace
    if (options.client) {
      this.client = options.client
      return
    }
    const credentials = base64(`${options.username ?? "opencode"}:${options.password}`)
    this.client = OpenCode.make({
      baseUrl: options.baseUrl,
      headers: { authorization: `Basic ${credentials}` },
    })
  }

  async info(): Promise<ServerInfo> {
    const info = await this.client.server.info()
    return { version: info.version, mode: "live", workspace: this.workspace }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const response = await this.client.session.list({ directory: this.workspace })
    return response.data.map((session) => normalizeSession(session, this.workspace))
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    let model: { id: string; providerID: string } | null = null
    if (input.model) {
      if (!this.modelProviders) await this.listModels()
      const providerID = this.modelProviders?.get(input.model)
      // An unknown choice is ignored like in `applyCompletion`: the host keeps
      // its own default instead of failing the new chat.
      if (providerID) model = { id: input.model, providerID }
    }
    const session = await this.client.session.create({
      location: { directory: input.directory },
      title: input.title ?? null,
      model,
      agent: input.agent ?? null,
    })
    return normalizeSession(session, input.directory)
  }

  async listMessages(sessionID: string): Promise<Message[]> {
    const response = await this.client.message.list({ sessionID })
    const messages: Message[] = []
    for (const entry of response.data) {
      const message = normalizeMessage(entry, sessionID)
      if (!message) continue
      messages.push(message)
    }
    return messages
  }

  async prompt(sessionID: string, input: PromptInput): Promise<PromptResult> {
    await applyCompletion(this.client, sessionID, input, async () => {
      if (!this.modelProviders) await this.listModels()
      return this.modelProviders ?? new Map()
    })
    const entry = await this.client.session.prompt({
      sessionID,
      text: input.text,
      id: input.id ?? null,
      // `@opencode/client@2.3.0` accepts `delivery: "steer" | "queue"` on
      // `session.prompt`; the queue intent is forwarded as-is.
      delivery: input.delivery === "queue" ? "queue" : null,
    })
    if (input.delivery !== "queue") return { messageID: entry.id }

    // The response itself does not say whether the prompt was deferred. The
    // inbox holds pending turns (spec 03), so an entry that is still listed
    // directly after acceptance was queued. A failure of this read-only probe
    // must not fail the successful prompt: leave `queued` undefined instead of
    // inventing an answer.
    try {
      const pending = await this.client.session.inbox.list({ sessionID })
      return {
        messageID: entry.id,
        queued: pending.some((item) => item.id === entry.id) ? true : undefined,
      }
    } catch {
      return { messageID: entry.id }
    }
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.client.session.interrupt({ sessionID })
  }

  async listInbox(sessionID: string): Promise<InboxEntry[]> {
    const entries = await this.client.session.inbox.list({ sessionID })
    return entries.map((entry) => ({
      id: entry.id,
      sessionID: entry.sessionID,
      kind: entry.type,
      text:
        entry.type === "user" || entry.type === "synthetic" ? entry.payload.text : "",
      delivery: entry.delivery,
      created: entry.time.created,
    }))
  }

  async cancelQueued(sessionID: string, messageID: string): Promise<void> {
    // `inbox.cancel` reports failures generically; a pre-read distinguishes an
    // unknown entry (404 in the BFF) from a transient client error.
    const entries = await this.client.session.inbox.list({ sessionID })
    if (!entries.some((entry) => entry.id === messageID)) {
      throw new BackendError("not_found", `Unknown queued message: ${messageID}`)
    }
    await this.client.session.inbox.cancel({ sessionID, inboxID: messageID })
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.client.model.list({ types: ["chat"] })
    this.modelProviders = new Map(response.data.map((model) => [model.modelID, model.providerID]))
    return response.data.map((model) => ({
      id: model.modelID,
      name: model.name,
      providerID: model.providerID,
    }))
  }

  async listAgents(): Promise<AgentInfo[]> {
    const response = await this.client.agent.list()
    return response.data.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
    }))
  }

  async listProviders() {
    return liveProviders(this.client)
  }

  async connectProviderKey(input: ProviderKeyInput): Promise<void> {
    await liveConnectKey(this.client, input)
  }

  async startProviderOAuth(input: ProviderOAuthInput) {
    return liveStartOAuth(this.client, input)
  }

  async providerOAuthStatus(input: { providerID: string; attemptID: string }) {
    return liveOAuthStatus(this.client, input.providerID, input.attemptID)
  }

  async completeProviderOAuth(input: ProviderAttemptInput): Promise<void> {
    await liveCompleteOAuth(this.client, input)
  }

  async cancelProviderOAuth(input: { providerID: string; attemptID: string }): Promise<void> {
    await liveCancelOAuth(this.client, input.providerID, input.attemptID)
  }

  async hostDefaultModel(): Promise<ModelInfo | null> {
    const response = await this.client.model.default()
    const model = response.data
    if (!model) return null
    return { id: model.modelID, name: model.name, providerID: model.providerID }
  }

  async listPermissions(sessionID: string): Promise<PermissionRequest[]> {
    const entries = await this.client.permission.list({ sessionID })
    return entries.map(normalizePermissionRequest)
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void> {
    await replyHostPermission(this.client, sessionID, requestID, decision)
  }

  async listApps(): Promise<AppsSnapshot> {
    return liveApps(this.client, this.workspace)
  }

  async connectApp(name: string): Promise<void> {
    await liveAppAction(this.client, this.workspace, "connect", name)
  }

  async disconnectApp(name: string): Promise<void> {
    await liveAppAction(this.client, this.workspace, "disconnect", name)
  }

  async search(input: SearchInput): Promise<SearchOutcome> {
    return liveSearch(this.client, this.workspace, input)
  }

  async listSchedules(sessionID: string): Promise<Schedule[]> {
    try {
      const rows = await this.client.experimental.schedule.list({ sessionID })
      return rows.map(normalizeSchedule)
    } catch (error) {
      throw mapScheduleError(error, "Schedules could not be listed")
    }
  }

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    try {
      const created = await this.client.experimental.schedule.create({
        sessionID: input.sessionID,
        prompt: input.prompt,
        when: scheduleWhen(input.ends),
      })
      return normalizeSchedule(created)
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be created")
    }
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    try {
      const paused = await this.client.experimental.schedule.pause({ scheduleID: id })
      return normalizeSchedule(paused)
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be paused")
    }
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    try {
      const resumed = await this.client.experimental.schedule.resume({ scheduleID: id })
      return normalizeSchedule(resumed)
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be resumed")
    }
  }

  async deleteSchedule(id: string): Promise<void> {
    try {
      await this.client.experimental.schedule.delete({ scheduleID: id })
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be deleted")
    }
  }

  async listJobs(): Promise<BackgroundJob[]> {
    try {
      const rows = await this.client.experimental.job.list()
      return rows.map(normalizeJob)
    } catch (error) {
      throw mapScheduleError(error, "Jobs could not be listed")
    }
  }

  async *subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    const queue = new EventQueue<V2Event>()
    // Tool names/inputs and the idle message id are stream state; each browser
    // gets its own map so a second subscriber cannot consume the first one's
    // entries.
    const state = createToolEventState()
    const remove = () => {
      if (!this.subscribers.delete(queue)) return
      queue.close()
      if (this.subscribers.size === 0) this.stopUpstream()
    }

    if (signal?.aborted) return
    this.subscribers.add(queue)
    this.ensureUpstream()
    signal?.addEventListener("abort", remove, { once: true })

    const iterator = queue[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield normalizeEvent(next.value, state)
      }
    } finally {
      signal?.removeEventListener("abort", remove)
      remove()
    }
  }

  /** Opens the one upstream subscription when the first browser attaches. */
  private ensureUpstream(): void {
    if (this.upstream) return
    const iterator = this.client.event.subscribe()[Symbol.asyncIterator]()
    this.upstream = iterator
    void this.pump(iterator)
  }

  /** Fans one upstream stream out to every attached subscriber. */
  private async pump(iterator: AsyncIterator<V2Event>): Promise<void> {
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        for (const queue of this.subscribers) queue.push(next.value)
      }
    } catch {
      // A dropped upstream ends this pump; subscribers fall through to `done`
      // and reconnect on their next request.
    }
    if (this.upstream === iterator) this.upstream = undefined
    if (this.upstream === undefined) {
      for (const queue of this.subscribers) queue.close()
      this.subscribers.clear()
    }
  }

  /** Closes the upstream subscription when the last browser leaves. */
  private stopUpstream(): void {
    const iterator = this.upstream
    if (!iterator) return
    this.upstream = undefined
    void iterator.return?.()
  }
}
