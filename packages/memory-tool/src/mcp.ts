import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { MEMORY_KINDS, MEMORY_STATUS, MEMORY_TRUST } from "@openchat/contracts"

/**
 * The MCP surface: one stdio server next to OpenCode. It speaks the subset
 * OpenCode's client needs (`initialize`, `ping`, `tools/list`, `tools/call`),
 * newline-delimited JSON-RPC. No HTTP transport, no session state, and no
 * store access of its own: every tool is forwarded to the BFF by the caller.
 */

export const SERVER_NAME = "openchat-memory"

/**
 * The manifest is the only version source: the release bump owns its `version`
 * field, so a literal here would silently drift. An unreadable or malformed
 * manifest falls back to a placeholder so the handshake still answers.
 */
export const PACKAGE_MANIFEST = new URL("../package.json", import.meta.url)
export const FALLBACK_VERSION = "0.0.0-dev"

/** Newest first; the first entry is the fallback for an unknown request. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read `version` from a manifest, falling back on any missing or malformed value. */
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

/** The version the `initialize` result reports. */
export const SERVER_VERSION = readManifestVersion()

export interface ToolCallResult {
  text: string
  isError: boolean
}

/** The caller receives the tool name and arguments and returns compact text. */
export type ToolCall = (name: string, args: unknown) => Promise<ToolCallResult>

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

interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
}

/** Schema enums come straight from the contracts surface so they cannot drift. */

const STRING_ARRAY = { type: "array", items: { type: "string" } } as const

const WRITE_ENTRY = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...MEMORY_KINDS] },
    text: { type: "string", minLength: 1 },
    topic: { type: "string", minLength: 1 },
    tags: STRING_ARRAY,
    trust: { type: "string", enum: [...MEMORY_TRUST] },
    source: {
      type: "object",
      properties: {
        sessionID: { type: "string" },
        messageID: { type: "string" },
        at: { type: "string" },
      },
      additionalProperties: false,
    },
    expiresAt: { type: "string" },
  },
  required: ["kind", "text", "topic"],
  additionalProperties: false,
} as const

const UPDATE_ENTRY = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    text: { type: "string" },
    topic: { type: "string" },
    tags: STRING_ARRAY,
    trust: { type: "string", enum: [...MEMORY_TRUST] },
    status: { type: "string", enum: [...MEMORY_STATUS] },
    confirm: { type: "boolean" },
    supersedes: STRING_ARRAY,
  },
  required: ["id"],
  additionalProperties: false,
} as const

/**
 * Eight batch-first tools. Descriptions are the model-facing contract: array
 * in, compact JSON out, no single-item variants, and a short retry instruction
 * so the model forwards arguments instead of inventing store access.
 */
export const MEMORY_TOOLS: readonly ToolDefinition[] = [
  {
    name: "mem_index",
    title: "Read the memory index",
    description:
      "Return the bounded memory index as `{ ok, index, entries, dropped }`; `index` is the derived INDEX.md content. The push layer of agent memory; do not edit it directly.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mem_find",
    title: "Find memory facts",
    description:
      "Rank active facts for several queries at once; optional tag and time filters. Returns compact rows. Excludes superseded, expired and deleted rows; use mem_get for those.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { ...STRING_ARRAY, minItems: 1 },
        tags: STRING_ARRAY,
        since: { type: "string" },
        limit: { type: "number", minimum: 1 },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_get",
    title: "Get memory records",
    description:
      "Fetch full records for a batch of ids, optionally only selected fields. Includes superseded, expired and deleted rows.",
    inputSchema: {
      type: "object",
      properties: { ids: { ...STRING_ARRAY, minItems: 1 }, fields: STRING_ARRAY },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_write",
    title: "Write memory facts",
    description:
      "Append a batch of atomic facts. The BFF dedupes by search first and applies write filters. Returns the stored ids. If a call is rejected, fix exactly what the message names and retry at most twice.",
    inputSchema: {
      type: "object",
      properties: { entries: { type: "array", items: WRITE_ENTRY, minItems: 1 } },
      required: ["entries"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_update",
    title: "Update memory facts",
    description:
      "Apply a batch of text, topic, status, confirmation and supersession edits. Returns the updated facts. Text and topic pass the same clean-room filters as write.",
    inputSchema: {
      type: "object",
      properties: { updates: { type: "array", items: UPDATE_ENTRY, minItems: 1 } },
      required: ["updates"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_delete",
    title: "Delete memory facts",
    description:
      "Soft-delete a batch of ids with a reason; rows are kept and linked, never hard-removed. Returns ok.",
    inputSchema: {
      type: "object",
      properties: { ids: { ...STRING_ARRAY, minItems: 1 }, reason: { type: "string", minLength: 1 } },
      required: ["ids", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_prune",
    title: "Prune memory facts",
    description:
      "Rank prune candidates with reasons. A dry run applies nothing; the agent or owner applies the result.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean" },
        maxAgeDays: { type: "number", minimum: 0 },
        superseded: { type: "boolean" },
        maxBytes: { type: "number", minimum: 0 },
      },
      required: ["dryRun"],
      additionalProperties: false,
    },
  },
  {
    name: "mem_stats",
    title: "Memory statistics",
    description: "Return counts, bytes, ages and lexical-miss telemetry for the store.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const

const TOOL_NAMES = new Set<string>(MEMORY_TOOLS.map((tool) => tool.name))

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
 * the tool dispatcher are injected, so the protocol can be tested offline.
 */
export async function handleRpc(message: unknown, call: ToolCall): Promise<JsonRpcResponse | null> {
  if (!isRecord(message)) return failure(null, -32700, "Parse error")

  const rawId = message.id
  const id: JsonRpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null
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
      return { jsonrpc: "2.0", id, result: { tools: [...MEMORY_TOOLS] } }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : ""
      if (!TOOL_NAMES.has(name)) return failure(id, -32602, "Unknown tool")
      try {
        const result = await call(name, isRecord(params.arguments) ? params.arguments : {})
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
  call: ToolCall
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
