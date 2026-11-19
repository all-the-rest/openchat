import type { EventEnvelope, ToolPart } from "@openchat/contracts"
import type { V2Event } from "@opencode/client"
import { normalizeForm } from "./live-forms"
import { textPartID } from "./live-normalize"

/**
 * The tool events in `@opencode/client` are split: only
 * `session.tool.input.started` carries the tool name, and
 * `session.tool.called`/`success`/`failed` do not (or only optionally) repeat
 * it. The adapter keeps a small map so a `ToolPart` can carry the name, the
 * accumulated streaming input and the start time until the tool finishes.
 *
 * One state instance is created per subscriber in `subscribe`, so names and
 * inputs never leak between browser streams. `assistants` remembers the newest
 * assistant message id per session because `session.idle` carries none.
 */
interface ToolStreamEntry {
  name: string
  startedAt: number
  input: string
}

export interface ToolEventState {
  readonly tools: Map<string, ToolStreamEntry>
  readonly assistants: Map<string, string>
}

export function createToolEventState(): ToolEventState {
  return { tools: new Map(), assistants: new Map() }
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
  const data = event.data as { sessionID?: unknown; assistantMessageID?: unknown }
  if (typeof data.sessionID === "string" && typeof data.assistantMessageID === "string") {
    state.assistants.set(data.sessionID, data.assistantMessageID)
  }

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
    case "session.inbox.enqueued": {
      const item = event.data.item
      return envelope(event, "session.inbox.enqueued", {
        sessionID: event.data.sessionID,
        messageID: event.data.inboxID,
        kind: item.type,
        // Only user and synthetic entries carry prompt text; the other kinds
        // are host bookkeeping and have nothing to display.
        text:
          item.type === "user" || item.type === "synthetic" ? item.payload.text : "",
        delivery: item.delivery,
        created: event.created,
      })
    }
    case "session.inbox.delivered":
    case "session.inbox.cancelled":
      return envelope(event, event.type, {
        sessionID: event.data.sessionID,
        messageID: event.data.inboxID,
      })
    case "session.inbox.delivery.changed":
      return envelope(event, "session.inbox.delivery.changed", {
        sessionID: event.data.sessionID,
        messageID: event.data.inboxID,
        delivery: event.data.delivery,
      })
    case "permission.asked": {
      const body = event.data
      const resources = Array.isArray(body.resources)
        ? body.resources.filter((item): item is string => typeof item === "string")
        : []
      return envelope(event, "permission.asked", {
        sessionID: body.sessionID,
        id: body.id,
        tool: body.action,
        action: body.message ?? resources.join(", "),
        resources,
      })
    }
    case "permission.replied":
      return envelope(event, "permission.replied", {
        sessionID: event.data.sessionID,
        requestID: event.data.requestID,
        decision: event.data.reply === "reject" ? "deny" : event.data.reply,
      })
    case "form.created": {
      // The host event carries the same payload as `session.form.list`, but it
      // bypasses the list path. Normalizing it here keeps the card identical
      // whether a form arrived by reload or by event, and drops host-only
      // variants (non-finite bounds, unknown field types) before the browser.
      const form = event.data.form
      if (form === null || typeof form !== "object") return passthrough(event)
      return envelope(event, event.type, {
        ...(event.data as unknown as Record<string, unknown>),
        form: normalizeForm(form),
      })
    }
    case "session.idle": {
      // `session.idle` only names the session. Claiming completion without an
      // id would make the client close whatever message happens to be last, so
      // use the assistant id the deltas announced. Without one, keep the event
      // as a distinct idle signal instead of inventing a completion.
      const messageID = state.assistants.get(event.data.sessionID)
      if (!messageID) {
        return envelope(event, "session.idle", { sessionID: event.data.sessionID })
      }
      state.assistants.delete(event.data.sessionID)
      return envelope(event, "session.message.completed", {
        sessionID: event.data.sessionID,
        messageID,
      })
    }
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
