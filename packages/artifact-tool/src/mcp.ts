import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

/**
 * The MCP surface: one stdio server next to OpenCode. It speaks the stdio
 * subset OpenCode's client needs (`initialize`, `tools/list`, `tools/call`,
 * `ping`), newline-delimited JSON-RPC. No HTTP transport, no session state,
 * no tool that writes anywhere except through the BFF.
 */

export const SERVER_NAME = "openchat-artifacts"
export const SERVER_VERSION = "0.1.0"

/** Newest first; the first entry is the fallback for an unknown request. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

export interface ToolCallResult {
  text: string
  isError: boolean
}

export type ToolHandler = (args: unknown) => Promise<ToolCallResult>

export type JsonRpcId = string | number | null

export interface JsonRpcSuccess {
  jsonrpc: "2.0"
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: "2.0"
  id: JsonRpcId
  error: { code: number; message: string }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/**
 * The model-facing contract. The description is the enforcement the prompt
 * cannot give: it names the retry budget and what the tool already injects, so
 * the model does not write imports or a network call in the first place.
 */
export const ARTIFACT_TOOL = {
  name: "openchat_app_write",
  title: "Write an interactive app",
  description: [
    "Store one interactive app (calculator, chart, simulation, dashboard) as a sandboxed artifact.",
    "Pass `title`, one Preact JSX module in `code`, and optional CSS in `css`.",
    "The module must declare `function App()` at top level and return JSX.",
    "Do not write imports: `h`, `Fragment`, `render`, `useState`, `useEffect`, `useMemo`,",
    "`useRef`, `useCallback` and `useReducer` from Preact are injected at write time.",
    "The app runs offline in a sandbox: no fetch/XHR/WebSocket, no CDN or URL literals,",
    "no storage or cookies, no eval/new Function/document.write, no window.open/top/parent.",
    "Style with the CSS variables --bg, --fg, --muted, --accent and --radius.",
    "If the tool rejects the input, fix exactly what the message names and retry at most twice;",
    "after that, explain the app in text instead. Returns { artifactID, title, bytes, warnings? }.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Plain-text title, at most 120 characters.",
        maxLength: 120,
      },
      code: {
        type: "string",
        description:
          "One JSX module with a top-level `function App()`; at most 64 KiB. No imports.",
      },
      css: {
        type: "string",
        description: "Optional stylesheet, at most 32 KiB, inlined into the document.",
      },
    },
    required: ["title", "code"],
    additionalProperties: false,
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function negotiateProtocol(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested
  }
  return DEFAULT_PROTOCOL_VERSION
}

function toolContent(result: ToolCallResult): unknown {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  }
}

/**
 * One JSON-RPC message in, one answer or `null` out. Pure: the transport and
 * the tool are injected, so the protocol can be tested without a process.
 */
export async function handleRpc(
  message: unknown,
  call: ToolHandler,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message)) return failure(null, -32700, "Parse error")

  const rawId = message.id
  const id: JsonRpcId =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : null
  const method = typeof message.method === "string" ? message.method : undefined
  if (!method) return failure(id, -32600, "Invalid Request")

  // A message without an id is a notification; it never gets an answer, even
  // when it is unknown or malformed.
  if (rawId === undefined) return null

  const params = isRecord(message.params) ? message.params : {}

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocol(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [ARTIFACT_TOOL] } }
    case "tools/call": {
      if (params.name !== ARTIFACT_TOOL.name) {
        return failure(id, -32602, "Unknown tool")
      }
      try {
        const result = await call(isRecord(params.arguments) ? params.arguments : {})
        return { jsonrpc: "2.0", id, result: toolContent(result) }
      } catch {
        return {
          jsonrpc: "2.0",
          id,
          result: toolContent({ text: "internal: the tool failed", isError: true }),
        }
      }
    }
    default:
      return failure(id, -32601, "Method not found")
  }
}

/**
 * Reads one JSON-RPC message per line until the input closes. A malformed line
 * gets a parse error and does not end the server; a tool error is a result,
 * never a crash.
 */
export async function serveStdio(options: {
  input: Readable
  output: Writable
  call: ToolHandler
}): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      options.output.write(`${JSON.stringify(failure(null, -32700, "Parse error"))}\n`)
      continue
    }

    const response = await handleRpc(parsed, options.call)
    if (response) options.output.write(`${JSON.stringify(response)}\n`)
  }
}
