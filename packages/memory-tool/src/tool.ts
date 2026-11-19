import type { MemoryOp, MemoryOpResult } from "@openchat/contracts"
import { postOp } from "./bff"
import type { BffOptions } from "./bff"

/**
 * Tool dispatch. Each of the eight MCP tools maps 1:1 onto an internal `op`;
 * arguments become the rest of the `MemoryOp` body. This is a thin client: it
 * validates only the tool name, forwards everything else to the BFF and never
 * reads or writes a store file itself.
 */

export type ToolDeps = BffOptions

type MemoryOpName = "index" | "find" | "get" | "write" | "update" | "delete" | "prune" | "stats"

export const TOOL_OPS: Record<string, MemoryOpName> = {
  mem_index: "index",
  mem_find: "find",
  mem_get: "get",
  mem_write: "write",
  mem_update: "update",
  mem_delete: "delete",
  mem_prune: "prune",
  mem_stats: "stats",
}

export type MemoryToolResult =
  | { ok: true; result: MemoryOpResult }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Audit actor for agent-originated writes. The BFF requires `actor` on every
 * mutating op; the MCP tool has no user identity, so it identifies itself as
 * the agent (the same value the store tests use for agent writes).
 */
export const MEMORY_ACTOR = "agent"

/**
 * Build the `MemoryOp` JSON sent to `POST /internal/memory`. Spread arguments
 * first and put `op`/`actor` last so a stray key in the arguments cannot
 * redirect the call or spoof the actor. `op`-only tools carry no arguments.
 *
 * The model-facing `mem_write` takes `entries`; the contract names that field
 * `inputs`, so the translation happens here rather than in the tool schema.
 */
export function buildMemoryOp(name: string, args: unknown): MemoryOp {
  const op = TOOL_OPS[name] ?? "index"
  const a = isRecord(args) ? args : {}
  let body: Record<string, unknown>
  switch (op) {
    case "index":
    case "stats":
      body = { op }
      break
    case "find":
    case "get":
      body = { ...a, op }
      break
    case "write": {
      const { entries, ...rest } = a
      body = { ...rest, op, inputs: entries, actor: MEMORY_ACTOR }
      break
    }
    default:
      body = { ...a, op, actor: MEMORY_ACTOR }
  }
  return body as unknown as MemoryOp
}

/** Dispatch one tool call through the BFF, returning its result or a fixed error line. */
export async function callMemoryTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<MemoryToolResult> {
  if (!(name in TOOL_OPS)) {
    return { ok: false, error: `internal: unknown memory tool ${name}` }
  }
  const posted = await postOp(deps, buildMemoryOp(name, args))
  if (!posted.ok) return { ok: false, error: posted.error }
  return { ok: true, result: posted.result }
}
