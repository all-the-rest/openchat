import { OpenCode } from "@opencode/client"
import type {
  AgentInfo,
  EventEnvelope,
  Message,
  MessageStatus,
  ModelInfo,
  Part,
  ServerInfo,
  SessionInfo,
  ToolPart,
  ToolStatus,
} from "@openchat/contracts"
import type {
  OpenCodeClient,
  SessionInfo as OpenCodeSessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  V2Event,
} from "@opencode/client"
import type {
  ChatBackend,
  CreateSessionInput,
  PromptInput,
  PromptResult,
} from "./index"

export interface LiveBackendOptions {
  baseUrl: string
  username?: string
  password: string
  workspace: string
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

function textPartID(messageID: string, kind: "text" | "reasoning", index: number): string {
  return `${messageID}_${kind}_${index}`
}

/**
 * The tool events in `@opencode/client` are split: only
 * `session.tool.input.started` carries the tool name, and
 * `session.tool.called`/`success`/`failed` do not (or only optionally) repeat
 * it. The adapter keeps a small per-stream map so a `ToolPart` can carry the
 * name, the accumulated streaming input and the start time until the tool
 * finishes. State is per subscriber and never leaks across streams.
 */
interface ToolStreamEntry {
  name: string
  startedAt: number
  input: string
}

export interface ToolEventState {
  readonly tools: Map<string, ToolStreamEntry>
}

export function createToolEventState(): ToolEventState {
  return { tools: new Map() }
}

function toolStatus(tool: SessionMessageAssistantTool): ToolStatus {
  switch (tool.state.status) {
    case "streaming":
    case "running":
      return "running"
    case "completed":
      return "success"
    case "error":
      return "error"
  }
}

function toolOutput(tool: SessionMessageAssistantTool): string | undefined {
  const state = tool.state
  if (state.status !== "completed" && state.status !== "error") return undefined
  const content = state.content
  if (!content) return undefined
  return content
    .map((entry) => (entry.type === "text" ? entry.text : entry.uri))
    .join("\n")
}

function mapTool(tool: SessionMessageAssistantTool): ToolPart {
  const state = tool.state
  const part: ToolPart = {
    type: "tool",
    id: tool.id,
    callID: tool.id,
    name: tool.name,
    status: toolStatus(tool),
    startedAt: tool.time.created,
  }
  if ("input" in state && state.input !== undefined) {
    part.input = typeof state.input === "string" ? state.input : JSON.stringify(state.input)
  }
  const output = toolOutput(tool)
  if (output !== undefined) part.output = output
  if (state.status === "error") part.error = state.error.message
  if (tool.time.completed !== undefined) part.endedAt = tool.time.completed
  return part
}

function assistantStatus(message: SessionMessageAssistant): MessageStatus {
  if (message.error) return "error"
  if (message.time.completed !== undefined) return "complete"
  return "streaming"
}

function assistantParts(message: SessionMessageAssistant): Part[] {
  const parts: Part[] = []
  let textIndex = 0
  let reasoningIndex = 0
  for (const content of message.content) {
    if (content.type === "text") {
      parts.push({ type: "text", id: textPartID(message.id, "text", textIndex), text: content.text })
      textIndex += 1
    } else if (content.type === "reasoning") {
      parts.push({
        type: "reasoning",
        id: textPartID(message.id, "reasoning", reasoningIndex),
        text: content.text,
      })
      reasoningIndex += 1
    } else if (content.type === "tool") {
      parts.push(mapTool(content))
    }
  }
  if (message.error) {
    parts.push({
      type: "error",
      id: `${message.id}_error`,
      message: message.error.message,
      code: message.error.type,
      retryable: message.error.retryAfterMs !== undefined,
    })
  }
  return parts
}

export function normalizeSession(info: OpenCodeSessionInfo, workspace?: string): SessionInfo {
  return {
    id: info.id,
    title: info.title ?? "",
    directory: info.location?.directory ?? workspace ?? "",
    created: info.time.created,
    updated: info.time.updated,
  }
}

/** Returns `null` for message types the M1 transcript does not render. */
export function normalizeMessage(info: SessionMessageInfo, sessionID = ""): Message | null {
  if (info.type === "user") {
    return {
      id: info.id,
      sessionID,
      role: "user",
      parts: [{ type: "text", id: `${info.id}_text`, text: info.text }],
      created: info.time.created,
      status: "complete",
    }
  }
  if (info.type === "assistant") {
    return {
      id: info.id,
      sessionID,
      role: "assistant",
      parts: assistantParts(info),
      created: info.time.created,
      status: assistantStatus(info),
    }
  }
  if (info.type === "system") {
    return {
      id: info.id,
      sessionID,
      role: "system",
      parts: [{ type: "text", id: `${info.id}_text`, text: info.text }],
      created: info.time.created,
      status: "complete",
    }
  }
  return null
}

function envelope(event: V2Event, type: string, data: Record<string, unknown>): EventEnvelope {
  const durable = "durable" in event ? event.durable : undefined
  // `server.connected` is the one event without a `created` field.
  const created = (event as { created?: number }).created ?? Date.now()
  const normalized: EventEnvelope = {
    id: event.id,
    created,
    type,
    data,
  }
  if (durable) {
    normalized.durable = {
      aggregateID: durable.aggregateID,
      seq: durable.seq,
      version: durable.version,
    }
  }
  return normalized
}

function passthrough(event: V2Event): EventEnvelope {
  return envelope(event, event.type, event.data as unknown as Record<string, unknown>)
}

/**
 * Maps the OpenCode 2.3 event stream onto the flat normalized envelope. The
 * client needs flat data, so `assistantMessageID` becomes `messageID`, and
 * `session.execution.interrupted` becomes `session.interrupted`. Tool events
 * share `state` so name, streamed input and duration survive the split event
 * shapes described on `ToolEventState`.
 */
export function normalizeEvent(
  event: V2Event,
  state: ToolEventState = createToolEventState(),
): EventEnvelope {
  switch (event.type) {
    case "session.text.delta":
      return envelope(event, event.type, {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        partID: textPartID(event.data.assistantMessageID, "text", event.data.ordinal),
        delta: event.data.delta,
      })
    case "session.reasoning.delta":
      return envelope(event, event.type, {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        partID: textPartID(event.data.assistantMessageID, "reasoning", event.data.ordinal),
        delta: event.data.delta,
      })
    case "session.execution.started":
    case "session.execution.succeeded":
      return envelope(event, event.type, { sessionID: event.data.sessionID })
    case "session.execution.failed":
      return envelope(event, event.type, {
        sessionID: event.data.sessionID,
        message: event.data.error.message,
        code: event.data.error.type,
        retryable: event.data.error.retryAfterMs !== undefined,
      })
    case "session.execution.interrupted":
      return envelope(event, "session.interrupted", {
        sessionID: event.data.sessionID,
        reason: event.data.reason,
      })
    case "session.idle":
      return envelope(event, "session.message.completed", {
        sessionID: event.data.sessionID,
      })
    case "session.tool.input.started": {
      const entry: ToolStreamEntry = {
        name: event.data.name,
        startedAt: event.created,
        input: "",
      }
      state.tools.set(event.data.id, entry)
      return envelope(event, "session.tool.updated", {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        part: {
          type: "tool",
          id: event.data.id,
          callID: event.data.id,
          name: entry.name,
          status: "running",
          input: entry.input,
          startedAt: entry.startedAt,
        } satisfies ToolPart,
      })
    }
    case "session.tool.input.delta": {
      const entry = state.tools.get(event.data.id)
      if (entry) entry.input += event.data.delta
      const part: ToolPart = {
        type: "tool",
        id: event.data.id,
        callID: event.data.id,
        name: entry?.name ?? "tool",
        status: "running",
        input: entry?.input ?? event.data.delta,
      }
      if (entry) part.startedAt = entry.startedAt
      return envelope(event, "session.tool.updated", {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        part,
      })
    }
    case "session.tool.input.ended": {
      const entry = state.tools.get(event.data.id)
      if (entry) entry.input = event.data.text
      const part: ToolPart = {
        type: "tool",
        id: event.data.id,
        callID: event.data.id,
        name: entry?.name ?? "tool",
        status: "running",
        input: entry?.input ?? event.data.text,
      }
      if (entry) part.startedAt = entry.startedAt
      return envelope(event, "session.tool.updated", {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        part,
      })
    }
    case "session.tool.called": {
      const entry = state.tools.get(event.data.id)
      const part: ToolPart = {
        type: "tool",
        id: event.data.id,
        callID: event.data.id,
        // `session.tool.called` has no `name` field in the client types; the
        // name comes from the preceding `session.tool.input.started` event.
        name: entry?.name ?? "tool",
        status: "running",
        input: entry && entry.input.length > 0 ? entry.input : JSON.stringify(event.data.input),
        startedAt: entry?.startedAt ?? event.created,
      }
      return envelope(event, "session.tool.updated", {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        part,
      })
    }
    case "session.tool.success": {
      const entry = state.tools.get(event.data.id)
      state.tools.delete(event.data.id)
      const part: ToolPart = {
        type: "tool",
        id: event.data.id,
        callID: event.data.id,
        name: entry?.name ?? "tool",
        status: "success",
        output: event.data.content
          .map((content) => (content.type === "text" ? content.text : "file"))
          .join("\n"),
        startedAt: entry?.startedAt,
        endedAt: event.created,
      }
      if (entry && entry.input.length > 0) part.input = entry.input
      return envelope(event, "session.tool.updated", {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        part,
      })
    }
    case "session.tool.failed": {
      const entry = state.tools.get(event.data.id)
      state.tools.delete(event.data.id)
      const part: ToolPart = {
        type: "tool",
        id: event.data.id,
        callID: event.data.id,
        // `session.tool.failed` has no `name` field either; use the name
        // recorded from `session.tool.input.started`.
        name: entry?.name ?? "tool",
        status: "error",
        error: event.data.error.message,
        startedAt: entry?.startedAt,
        endedAt: event.created,
      }
      if (entry && entry.input.length > 0) part.input = entry.input
      return envelope(event, "session.tool.updated", {
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        part,
      })
    }
    default:
      return passthrough(event)
  }
}

/**
 * Adapter for a real `opencode serve` instance. It typechecks against
 * `@opencode/client@2.3.0`; there is no live test in CI.
 */
export class LiveBackend implements ChatBackend {
  private readonly client: OpenCodeClient
  private readonly workspace: string
  private readonly toolState = createToolEventState()

  constructor(options: LiveBackendOptions) {
    this.workspace = options.workspace
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
    const session = await this.client.session.create({
      location: { directory: input.directory },
      title: input.title ?? null,
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

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.client.model.list({ types: ["chat"] })
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

  async *subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    const iterator = this.client.event.subscribe()[Symbol.asyncIterator]()
    const aborted = new Promise<IteratorResult<never>>((resolve) => {
      if (!signal) return
      if (signal.aborted) {
        resolve({ value: undefined, done: true })
        return
      }
      signal.addEventListener(
        "abort",
        () => resolve({ value: undefined, done: true }),
        { once: true },
      )
    })
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), aborted])
        if (next.done) return
        yield normalizeEvent(next.value, this.toolState)
      }
    } finally {
      await iterator.return?.()
    }
  }
}
