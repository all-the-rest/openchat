import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

/**
 * The MCP surface: eight batch-first memory tools over a small stdio JSON-RPC
 * subset. Every tool takes arrays and returns one compact JSON line, so a Code
 * Mode script can search, filter, fetch and write in a single step without the
 * intermediate rows entering the model context.
 */
export const SERVER_NAME = "openchat-memory"
export const PACKAGE_MANIFEST = new URL("../package.json", import.meta.url)
export const FALLBACK_VERSION = "0.0.0-dev"
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

const RETRY = "If a tool rejects input, fix exactly what the error names and retry at most twice."

function strings(...names: string[]) {
  return { type: "array", items: { type: "string" }, description: names.join(", ") }
}

export const MEMORY_TOOLS = [
  {
    name: "mem_index",
    title: "Read the bounded memory index",
    description: "Returns INDEX.md, the small ranked push layer. No arguments; safe to call often.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mem_find",
    title: "Search memory facts",
    description: [
      "Keyword search over text, tags and topic. Pass several queries in one call.",
      "Excludes superseded, expired and deleted facts; use mem_get to fetch those by id.",
      RETRY,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        queries: strings("Search phrases; empty returns all active facts"),
        tags: strings("Optional tag filter (all must match)"),
        since: { type: "string", description: "ISO timestamp; only facts confirmed since then" },
        limit: { type: "number", description: "1–50 rows" },
        fields: strings("Optional projection, e.g. id, text, topic"),
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_get",
    title: "Fetch full facts by id",
    description: "Fetch full records for chosen ids, including superseded, expired and deleted ones.",
    inputSchema: {
      type: "object",
      properties: {
        ids: strings("Fact ids, at most 100"),
        fields: strings("Optional field projection"),
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_write",
    title: "Write memory facts",
    description: [
      "Write a batch of atomic facts. Search first: near-identical active facts are rejected as duplicateOf.",
      "Secrets and instruction-like text are refused with a stable code. Same-topic writes supersede the old fact.",
      RETRY,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          description: "Objects with text, topic and optional tags, trust, source, id",
          items: { type: "object" },
        },
      },
      required: ["entries"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_update",
    title: "Update memory facts",
    description: "Apply a batch of field changes; confirm:true resets the TTL clock.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          description: "Objects with id and optional text, topic, tags, trust, status, expiresAt, confirm, reason",
          items: { type: "object" },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_delete",
    title: "Soft-delete memory facts",
    description: "Soft-delete by id with a reason. Never refused, so an oversized store can always shrink.",
    inputSchema: {
      type: "object",
      properties: {
        ids: strings("Fact ids to soft-delete"),
        reason: { type: "string", description: "Why these facts were removed" },
      },
      required: ["ids", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_prune",
    title: "Plan or apply a prune",
    description: [
      "Dry run returns ranked candidates with reasons. Nothing is removed unless dryRun is exactly false.",
      "Reasons: stale, superseded, duplicate, oversized.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Defaults to true" },
        maxAgeDays: { type: "number" },
        superseded: { type: "boolean" },
        maxBytes: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mem_stats",
    title: "Memory store statistics",
    description: "Counts by status, byte usage and topic count. No arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const

export const TOOL_NAMES = MEMORY_TOOLS.map((tool) => tool.name)

export type ToolName = (typeof TOOL_NAMES)[number]

export interface ToolCallResult {
  text: string
  isError: boolean
}

export type ToolHandler = (name: string, args: unknown) => Promise<ToolCallResult>

export type JsonRpcId = string | number | null

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readManifestVersion(manifest: URL = PACKAGE_MANIFEST): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"))
    if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // The handshake answers even without a manifest version.
  }
  return FALLBACK_VERSION
}

export const SERVER_VERSION = readManifestVersion()

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function negotiateProtocol(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested
  }
  return DEFAULT_PROTOCOL_VERSION
}

function isKnownTool(name: unknown): name is ToolName {
  return typeof name === "string" && (TOOL_NAMES as readonly string[]).includes(name)
}

/** One message in, one answer or null out; pure so the protocol is testable. */
export async function handleRpc(message: unknown, call: ToolHandler): Promise<JsonRpcResponse | null> {
  if (!isRecord(message)) return failure(null, -32700, "Parse error")
  const rawId = message.id
  const id: JsonRpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null
  const method = typeof message.method === "string" ? message.method : undefined
  if (!method) return failure(id, -32600, "Invalid Request")
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
      return { jsonrpc: "2.0", id, result: { tools: [...MEMORY_TOOLS] } }
    case "tools/call": {
      if (!isKnownTool(params.name)) return failure(id, -32602, "Unknown tool")
      try {
        const result = await call(params.name, isRecord(params.arguments) ? params.arguments : {})
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) },
        }
      } catch {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "internal: the memory tool failed" }], isError: true },
        }
      }
    }
    default:
      return failure(id, -32601, "Method not found")
  }
}

/** Reads newline-delimited JSON-RPC until stdin closes; a bad line is answered. */
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
    if (response !== null) options.output.write(`${JSON.stringify(response)}\n`)
  }
}
