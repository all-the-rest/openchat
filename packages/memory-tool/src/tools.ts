/**
 * Tool dispatch. Each tool validates its batch shape, calls the shared store,
 * and returns one compact JSON object (never pretty-printed). Mutations refresh
 * the index in the store and then notify the BFF; a failed notification is
 * reported as `notified:false` but never as a tool error.
 */
import type { MemoryStore } from "@openchat/memory-store"
import { estimateTokens, MAX_FIND_ROWS, MAX_GET_IDS } from "@openchat/memory-store"
import type {
  DeleteOutcome,
  PruneCandidate,
  UpdateOutcome,
  WriteOutcome,
} from "@openchat/memory-store"
import type { ToolCallResult } from "./mcp"

export interface ToolDeps {
  store: MemoryStore
  /** Injected notify; defaults to the no-op below when not configured. */
  notify?: () => Promise<boolean>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(message: string): ToolCallResult {
  return { text: JSON.stringify({ error: message }), isError: true }
}

function ok(value: unknown): ToolCallResult {
  return { text: JSON.stringify(value), isError: false }
}

function stringArray(value: unknown, field: string, max: number): string[] | string {
  if (!Array.isArray(value)) return `${field}: must be an array`
  if (value.length > max) return `${field}: at most ${max} entries`
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string") return `${field}: entries must be strings`
    result.push(item)
  }
  return result
}

function numberField(value: unknown, field: string, min: number, max: number): number | string {
  if (value === undefined) return min
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field}: must be a number`
  if (value < min || value > max) return `${field}: out of range`
  return value
}

function booleanField(value: unknown, field: string, fallback: boolean): boolean | string {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") return `${field}: must be a boolean`
  return value
}

/** Caps an already-filtered array so no tool result can flood the context. */
function cap<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  return rows.length > limit ? { rows: rows.slice(0, limit), truncated: true } : { rows, truncated: false }
}

async function afterMutation(deps: ToolDeps, payload: Record<string, unknown>): Promise<ToolCallResult> {
  const notified = deps.notify ? await deps.notify() : false
  return ok({ ...payload, notified, index: await deps.store.index() })
}

/** Dispatch by tool name; every rejection is a short stable message. */
export async function runMemoryTool(name: string, args: unknown, deps: ToolDeps): Promise<ToolCallResult> {
  if (!isRecord(args)) return fail("input: expected an object")
  const { store } = deps

  switch (name) {
    case "mem_index": {
      const index = await store.index()
      return ok({ index, tokens: estimateTokens(index) })
    }

    case "mem_find": {
      const queries = stringArray(args.queries, "queries", 20)
      if (typeof queries === "string") return fail(queries)
      const tags = args.tags === undefined ? [] : stringArray(args.tags, "tags", 20)
      if (typeof tags === "string") return fail(tags)
      const fields = args.fields === undefined ? undefined : stringArray(args.fields, "fields", 20)
      if (typeof fields === "string") return fail(fields)
      const limit = numberField(args.limit, "limit", 1, MAX_FIND_ROWS)
      if (typeof limit === "string") return fail(limit)
      if (args.since !== undefined && typeof args.since !== "string") return fail("since: must be a string")
      const rows = await store.find({
        queries,
        tags,
        limit: args.limit === undefined ? undefined : limit,
        ...(typeof args.since === "string" ? { since: args.since } : {}),
        ...(fields ? { fields } : {}),
      })
      return ok({ results: rows })
    }

    case "mem_get": {
      const ids = stringArray(args.ids, "ids", MAX_GET_IDS)
      if (typeof ids === "string") return fail(ids)
      const fields = args.fields === undefined ? undefined : stringArray(args.fields, "fields", 30)
      if (typeof fields === "string") return fail(fields)
      const results = await store.get(ids, fields)
      return ok({ results })
    }

    case "mem_write": {
      if (!Array.isArray(args.entries)) return fail("entries: must be an array")
      if (args.entries.length > 100) return fail("entries: at most 100 per call")
      const results: WriteOutcome[] = await store.write(args.entries, "agent")
      return afterMutation(deps, { results })
    }

    case "mem_update": {
      if (!Array.isArray(args.updates)) return fail("updates: must be an array")
      if (args.updates.length > 100) return fail("updates: at most 100 per call")
      const results: UpdateOutcome[] = await store.update(args.updates, "agent")
      return afterMutation(deps, { results })
    }

    case "mem_delete": {
      const ids = stringArray(args.ids, "ids", MAX_GET_IDS)
      if (typeof ids === "string") return fail(ids)
      if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
        return fail("reason: must be a non-empty string")
      }
      const results: DeleteOutcome[] = await store.delete(ids, args.reason, "agent")
      return afterMutation(deps, { results, reason: args.reason })
    }

    case "mem_prune": {
      const dryRun = booleanField(args.dryRun, "dryRun", true)
      if (typeof dryRun === "string") return fail(dryRun)
      const maxAgeDays = numberField(args.maxAgeDays, "maxAgeDays", 0, 3650)
      if (typeof maxAgeDays === "string") return fail(maxAgeDays)
      const maxBytes = numberField(args.maxBytes, "maxBytes", 1, 1_048_576)
      if (typeof maxBytes === "string") return fail(maxBytes)
      const superseded = booleanField(args.superseded, "superseded", true)
      if (typeof superseded === "string") return fail(superseded)
      const result = await store.prune(
        {
          dryRun,
          superseded,
          ...(args.maxAgeDays === undefined ? {} : { maxAgeDays }),
          ...(args.maxBytes === undefined ? {} : { maxBytes }),
        },
        "agent",
      )
      const candidates: PruneCandidate[] = result.candidates
      const preview = cap(candidates, MAX_FIND_ROWS)
      if (result.dryRun) return ok({ dryRun: true, candidates: preview.rows, truncated: preview.truncated })
      return afterMutation(deps, { dryRun: false, applied: result.applied, candidates: preview.rows })
    }

    case "mem_stats": {
      return ok(await store.stats())
    }

    default:
      return fail("input: unknown tool")
  }
}
