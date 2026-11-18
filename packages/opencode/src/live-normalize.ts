import type {
  Message,
  MessageStatus,
  Part,
  SessionInfo,
  ToolPart,
  ToolStatus,
} from "@openchat/contracts"
import type {
  SessionInfo as OpenCodeSessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"

export function textPartID(messageID: string, kind: "text" | "reasoning", index: number): string {
  return `${messageID}_${kind}_${index}`
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
  const session: SessionInfo = {
    id: info.id,
    title: info.title ?? "",
    directory: info.location?.directory ?? workspace ?? "",
    created: info.time.created,
    updated: info.time.updated,
  }
  // A normal chat has no parent; the key stays absent instead of becoming
  // `undefined`, so the normalized shape mirrors the host.
  if (info.parentID) session.parentID = info.parentID
  return session
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
