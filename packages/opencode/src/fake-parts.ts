import { EVENT } from "@openchat/contracts"
import type {
  ErrorPart,
  EventEnvelope,
  Message,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@openchat/contracts"
import type { IdPrefix } from "./fake-events"

export function clone<T>(value: T): T {
  return structuredClone(value)
}

/** What the writer needs from the backend that owns the state. */
interface PartWriterContext {
  nextID(prefix: IdPrefix): string
  clock(): number
  emit(
    type: string,
    sessionID: string,
    data: Record<string, unknown>,
    durable: boolean,
  ): EventEnvelope
}

/**
 * Builds and mutates the parts of one scripted assistant message and emits the
 * matching deltas. Ids, the clock and the subscriber fan-out stay in the
 * backend; this class keeps the message/event shaping in one place.
 */
export class PartWriter {
  constructor(private readonly context: PartWriterContext) {}

  addText(message: Message): TextPart {
    const part: TextPart = { type: "text", id: this.context.nextID("part"), text: "" }
    message.parts.push(part)
    return part
  }

  addReasoning(message: Message): ReasoningPart {
    const part: ReasoningPart = { type: "reasoning", id: this.context.nextID("part"), text: "" }
    message.parts.push(part)
    return part
  }

  addTool(message: Message, name: string, input: string): ToolPart {
    const part: ToolPart = {
      type: "tool",
      id: this.context.nextID("part"),
      callID: this.context.nextID("call"),
      name,
      status: "running",
      input,
      startedAt: this.context.clock(),
    }
    message.parts.push(part)
    return part
  }

  streamText(sessionID: string, message: Message, partID: string, delta: string): void {
    const part = message.parts.find((entry) => entry.id === partID)
    if (part?.type === "text") part.text += delta
    this.context.emit(EVENT.textDelta, sessionID, {
      sessionID,
      messageID: message.id,
      partID,
      delta,
    }, false)
  }

  streamReasoning(sessionID: string, message: Message, partID: string, delta: string): void {
    const part = message.parts.find((entry) => entry.id === partID)
    if (part?.type === "reasoning") part.text += delta
    this.context.emit(EVENT.reasoningDelta, sessionID, {
      sessionID,
      messageID: message.id,
      partID,
      delta,
    }, false)
  }

  emitTool(sessionID: string, message: Message, part: ToolPart, patch: Partial<ToolPart>): void {
    Object.assign(part, patch)
    if (patch.status === "success" || patch.status === "error") part.endedAt = this.context.clock()
    this.context.emit(EVENT.toolUpdated, sessionID, {
      sessionID,
      messageID: message.id,
      part: clone(part),
    }, true)
  }

  addError(
    sessionID: string,
    message: Message,
    text: string,
    code: string,
    retryable: boolean,
  ): void {
    const part: ErrorPart = {
      type: "error",
      id: this.context.nextID("part"),
      message: text,
      code,
      retryable,
    }
    message.parts.push(part)
    this.context.emit(EVENT.error, sessionID, {
      sessionID,
      messageID: message.id,
      message: text,
      code,
      retryable,
      part: clone(part),
    }, true)
  }
}

export function errorText(message: Message): string | undefined {
  const part = message.parts.find((entry) => entry.type === "error")
  return part?.type === "error" ? part.message : undefined
}
