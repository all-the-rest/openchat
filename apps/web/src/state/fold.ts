import type {
  ErrorPart,
  EventEnvelope,
  Message,
  MessageStatus,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolStatus,
} from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"

/**
 * Fold one normalized event into the transcript (spec 03).
 *
 * Pure: the input array and its messages are never mutated. Unknown event
 * types return the input reference unchanged so React can skip a render.
 */

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === "string" ? value : undefined
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key]
  return typeof value === "boolean" ? value : undefined
}

function replaceMessage(messages: Message[], index: number, message: Message): Message[] {
  return messages.map((current, position) => (position === index ? message : current))
}

function lastStreamingIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.status === "streaming") return index
  }
  return -1
}

function lastAssistantIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return index
  }
  return -1
}

type DeltaType = "text" | "reasoning"

function appendDelta(
  messages: Message[],
  event: EventEnvelope,
  type: DeltaType,
): Message[] {
  const data = event.data
  const messageID = readString(data, "messageID") ?? readString(data, "assistantMessageID")
  const delta = readString(data, "delta") ?? ""
  if (!messageID || delta.length === 0) return messages

  const sessionID = readString(data, "sessionID") ?? ""
  const partID =
    readString(data, "partID") ?? `${type}-${readNumber(data, "ordinal") ?? 0}`

  const index = messages.findIndex((message) => message.id === messageID)
  if (index === -1) {
    const part: TextPart | ReasoningPart = { type, id: partID, text: delta }
    const created: Message = {
      id: messageID,
      sessionID,
      role: "assistant",
      parts: [part],
      created: event.created,
      status: "streaming",
    }
    return [...messages, created]
  }

  const message = messages[index]
  if (!message) return messages

  const partIndex = message.parts.findIndex(
    (part) => part.type === type && part.id === partID,
  )
  const parts: Part[] =
    partIndex === -1
      ? [...message.parts, { type, id: partID, text: delta }]
      : message.parts.map((part, position) => {
          if (position !== partIndex || part.type !== type) return part
          return { ...part, text: part.text + delta }
        })

  return replaceMessage(messages, index, { ...message, parts })
}

const TOOL_STATUSES: readonly ToolStatus[] = ["queued", "running", "success", "error"]

function readToolPart(value: unknown): ToolPart | null {
  if (value === null || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (raw.type !== "tool") return null
  const id = typeof raw.id === "string" ? raw.id : undefined
  const name = typeof raw.name === "string" ? raw.name : undefined
  const status =
    typeof raw.status === "string" && TOOL_STATUSES.includes(raw.status as ToolStatus)
      ? (raw.status as ToolStatus)
      : undefined
  if (!id || !name || !status) return null

  const part: ToolPart = {
    type: "tool",
    id,
    callID: typeof raw.callID === "string" ? raw.callID : id,
    name,
    status,
  }
  if (typeof raw.input === "string") part.input = raw.input
  if (typeof raw.output === "string") part.output = raw.output
  if (typeof raw.error === "string") part.error = raw.error
  if (typeof raw.startedAt === "number") part.startedAt = raw.startedAt
  if (typeof raw.endedAt === "number") part.endedAt = raw.endedAt
  return part
}

function readSnapshotPart(value: unknown): Part | null {
  if (value === null || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== "string" || raw.id.length === 0) return null
  const text = typeof raw.text === "string" ? raw.text : ""

  if (raw.type === "text") return { type: "text", id: raw.id, text }
  if (raw.type === "reasoning") return { type: "reasoning", id: raw.id, text }
  if (raw.type === "tool") return readToolPart(raw)
  if (raw.type === "error") {
    const part: ErrorPart = {
      type: "error",
      id: raw.id,
      message: typeof raw.message === "string" ? raw.message : "",
    }
    if (typeof raw.code === "string") part.code = raw.code
    if (typeof raw.retryable === "boolean") part.retryable = raw.retryable
    return part
  }
  return null
}

/**
 * Merges an authoritative message snapshot into the transcript: parts are
 * matched by id, existing ones are replaced and new ones appended. Parts that
 * the snapshot does not mention survive, so a partial snapshot never truncates
 * the transcript (spec 10 M).
 */
function mergeSnapshotParts(current: Part[], snapshot: Part[]): Part[] {
  if (snapshot.length === 0) return current
  const merged = [...current]
  for (const part of snapshot) {
    const index = merged.findIndex((entry) => entry.id === part.id)
    if (index === -1) merged.push(part)
    else merged[index] = part
  }
  return merged
}

function applyToolUpdated(messages: Message[], event: EventEnvelope): Message[] {
  const messageID = readString(event.data, "messageID")
  const part = readToolPart(event.data.part)
  if (!messageID || !part) return messages

  const index = messages.findIndex((message) => message.id === messageID)
  if (index === -1) {
    const created: Message = {
      id: messageID,
      sessionID: readString(event.data, "sessionID") ?? "",
      role: "assistant",
      parts: [part],
      created: event.created,
      status: "streaming",
    }
    return [...messages, created]
  }

  const message = messages[index]
  if (!message) return messages

  const partIndex = message.parts.findIndex((entry) => entry.id === part.id)
  const parts: Part[] =
    partIndex === -1
      ? [...message.parts, part]
      : message.parts.map((entry, position) => (position === partIndex ? part : entry))

  return replaceMessage(messages, index, { ...message, parts })
}

function readMessageStatus(value: string | undefined): MessageStatus {
  if (value === "stopped" || value === "error" || value === "complete") return value
  return "complete"
}

function setMessageStatus(
  messages: Message[],
  messageID: string | undefined,
  status: MessageStatus,
): Message[] {
  let index = messageID
    ? messages.findIndex((message) => message.id === messageID)
    : lastStreamingIndex(messages)
  if (index === -1) index = lastStreamingIndex(messages)
  if (index === -1) return messages

  const message = messages[index]
  if (!message || message.status === status) return messages
  return replaceMessage(messages, index, { ...message, status })
}

function applyErrorEvent(messages: Message[], event: EventEnvelope): Message[] {
  const data = event.data
  const sessionID = readString(data, "sessionID") ?? ""
  const messageID = readString(data, "messageID")
  const errorID = `error-${event.id || String(event.created)}`

  const errorPart: ErrorPart = {
    type: "error",
    id: errorID,
    message: readString(data, "message") ?? "",
  }
  const code = readString(data, "code")
  if (code) errorPart.code = code
  const retryable = readBoolean(data, "retryable")
  if (retryable !== undefined) errorPart.retryable = retryable

  let index = messageID
    ? messages.findIndex((message) => message.id === messageID)
    : lastStreamingIndex(messages)
  if (index === -1) index = lastAssistantIndex(messages)

  if (index === -1) {
    const created: Message = {
      id: messageID ?? `error-${event.id || String(event.created)}`,
      sessionID,
      role: "assistant",
      parts: [errorPart],
      created: event.created,
      status: "error",
    }
    return [...messages, created]
  }

  const message = messages[index]
  if (!message) return messages
  if (message.parts.some((part) => part.id === errorPart.id)) return messages

  // A failed execution after a structured session.error must not stack a
  // second error card; the first one is more specific.
  if (message.parts.some((part) => part.type === "error")) {
    if (message.status === "error") return messages
    return replaceMessage(messages, index, { ...message, status: "error" })
  }

  return replaceMessage(messages, index, {
    ...message,
    parts: [...message.parts, errorPart],
    status: "error",
  })
}

export function applyEvent(messages: Message[], event: EventEnvelope): Message[] {
  switch (event.type) {
    case EVENT.textDelta:
      return appendDelta(messages, event, "text")

    case EVENT.reasoningDelta:
      return appendDelta(messages, event, "reasoning")

    case EVENT.toolUpdated:
      return applyToolUpdated(messages, event)

    case EVENT.messageCompleted: {
      let messageID = readString(event.data, "messageID")
      let status = readString(event.data, "status")

      // Live backends send an authoritative message snapshot; its status is
      // what keeps an interrupted message `stopped` (spec 03). Its parts are
      // merged so tool results that arrived only in the snapshot survive.
      const snapshot = event.data.message
      let snapshotParts: Part[] = []
      if (snapshot !== null && typeof snapshot === "object") {
        const record = snapshot as Record<string, unknown>
        if (!messageID && typeof record.id === "string") messageID = record.id
        if (!status && typeof record.status === "string") status = record.status
        if (Array.isArray(record.parts)) {
          snapshotParts = record.parts
            .map(readSnapshotPart)
            .filter((part): part is Part => part !== null)
        }
      }

      let index = messageID
        ? messages.findIndex((message) => message.id === messageID)
        : lastStreamingIndex(messages)
      if (index === -1) index = lastStreamingIndex(messages)
      if (index === -1) return messages

      const message = messages[index]
      if (!message) return messages

      const nextStatus = readMessageStatus(status)
      const parts = mergeSnapshotParts(message.parts, snapshotParts)
      if (parts === message.parts && message.status === nextStatus) return messages

      return replaceMessage(messages, index, { ...message, parts, status: nextStatus })
    }

    case EVENT.interrupted:
      return setMessageStatus(messages, readString(event.data, "messageID"), "stopped")

    case EVENT.error:
    case EVENT.executionFailed:
      return applyErrorEvent(messages, event)

    default:
      return messages
  }
}

/** Terminal events end a live run; the composer stops showing stop. */
export function isTerminalEvent(type: string): boolean {
  return (
    type === EVENT.messageCompleted ||
    type === EVENT.interrupted ||
    type === EVENT.error ||
    type === EVENT.executionFailed ||
    type === EVENT.executionSucceeded
  )
}
