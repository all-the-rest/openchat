import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { ToolSpec } from "./tools"

/**
 * The MCP surface: one stdio server next to OpenCode. It answers the subset
 * OpenCode's client needs (`initialize`, `tools/list`, `tools/call`, `ping`)
 * as newline-delimited JSON-RPC. The registry is injected, so the protocol is
 * testable without a process and without Python.
 */

export const SERVER_NAME = "openchat-documents"

export const PACKAGE_MANIFEST = new URL("../package.json", import.meta.url)
export const FALLBACK_VERSION = "0.0.0-dev"

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A missing field, unreadable file or malformed JSON falls back to the placeholder. */
export function readManifestVersion(manifest: URL = PACKAGE_MANIFEST): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"))
    if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // Fall through to the placeholder.
  }
  return FALLBACK_VERSION
}

export const SERVER_VERSION = readManifestVersion()

export interface ToolCallResult {
  text: string
  isError: boolean
}

export type ToolHandler = (name: string, args: unknown) => Promise<ToolCallResult>

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

/** One JSON-RPC message in, one answer or `null` out. Pure. */
export async function handleRpc(
  message: unknown,
  tools: readonly ToolSpec[],
  call: ToolHandler,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message)) return failure(null, -32700, "Parse error")

  const rawId = message.id
  const id: JsonRpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null
  const method = typeof message.method === "string" ? message.method : undefined
  if (!method) return failure(id, -32600, "Invalid Request")

  // A notification never gets an answer, even when it is unknown or malformed.
  if (rawId === undefined) return null

  const params = isRecord(message.params) ? message.params : {}
  const known = tools.find((tool) => tool.name === params.name)

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
      return { jsonrpc: "2.0", id, result: { tools } }
    case "tools/call": {
      if (!known) return failure(id, -32602, "Unknown tool")
      try {
        const result = await call(known.name, isRecord(params.arguments) ? params.arguments : {})
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

/** Reads one JSON-RPC message per line until the input closes. */
export async function serveStdio(options: {
  input: Readable
  output: Writable
  tools: readonly ToolSpec[]
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

    const response = await handleRpc(parsed, options.tools, options.call)
    if (response) options.output.write(`${JSON.stringify(response)}\n`)
  }
}
