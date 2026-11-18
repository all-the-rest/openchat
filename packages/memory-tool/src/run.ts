import type { MemoryFact } from "@openchat/contracts"
import type { MemoryItemResult, MemoryStore } from "@openchat/memory-store"
import { estimateTokens } from "@openchat/memory-store"
import { MEMORY_TOOL_NAMES } from "./tools"
import type { MemoryToolName } from "./tools"
import {
  ToolInputError,
  parseDelete,
  parseFields,
  parseFind,
  parseIds,
  parsePrune,
  parseUpdate,
  parseWrite,
} from "./validate"

/**
 * Tool dispatch. Results are compact JSON with hard caps, so a batch never
 * dumps the store into the model context. A per-entry rejection is a normal
 * result; only bad arguments or an internal failure become `isError`.
 */

export interface ToolCallResult {
  text: string
  isError: boolean
}

export type MemoryNotifier = () => Promise<void>

export interface MemoryToolDeps {
  store: MemoryStore
  /** Called after any mutation; a failure here must not fail the write. */
  notify?: MemoryNotifier
}

const MAX_RESULT_BYTES = 48_000
const MATCHES_PER_QUERY = 10

function json(value: unknown): string {
  return JSON.stringify(value)
}

function bytes(value: unknown): number {
  return Buffer.byteLength(json(value), "utf8")
}

interface CompactResult {
  ok: boolean
  id?: string
  code?: string
  duplicateOf?: string
  topic?: string
  supersedes?: string[]
}

function compactResult(result: MemoryItemResult): CompactResult {
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      ...(result.id === undefined ? {} : { id: result.id }),
      ...(result.duplicateOf === undefined ? {} : { duplicateOf: result.duplicateOf }),
    }
  }
  return {
    ok: true,
    id: result.fact.id,
    topic: result.fact.topic,
    ...(result.fact.supersedes.length > 0 ? { supersedes: result.fact.supersedes } : {}),
  }
}

function pick(fact: MemoryFact, fields: readonly string[] | undefined): Record<string, unknown> {
  if (!fields) return { ...fact }
  const picked: Record<string, unknown> = {}
  for (const field of fields) {
    if (Object.hasOwn(fact, field)) {
      picked[field] = (fact as unknown as Record<string, unknown>)[field]
    }
  }
  return picked
}

async function runFind(args: unknown, deps: MemoryToolDeps): Promise<unknown> {
  const input = parseFind(args)
  const results: Array<{ query: string; matches: unknown[] }> = []
  let used = 0
  let truncated = false
  for (const query of input.queries) {
    const matches: unknown[] = []
    const rows = await deps.store.find(query, {
      tags: input.tags,
      since: input.since,
      limit: Math.min(input.limit ?? MATCHES_PER_QUERY, MATCHES_PER_QUERY),
    })
    for (const row of rows) {
      const compact = {
        id: row.id,
        topic: row.topic,
        text: row.text,
        tags: row.tags,
        trust: row.trust,
        score: Number(row.score.toFixed(3)),
        lastConfirmedAt: row.lastConfirmedAt,
        source: row.source,
      }
      const size = bytes(compact)
      if (used + size > MAX_RESULT_BYTES) {
        truncated = true
        break
      }
      used += size
      matches.push(compact)
    }
    results.push({ query, matches })
    if (truncated) break
  }
  return { results, ...(truncated ? { truncated: true } : {}) }
}

async function runMutation(
  deps: MemoryToolDeps,
  mutate: () => Promise<MemoryItemResult[]>,
): Promise<unknown> {
  const results = (await mutate()).map(compactResult)
  if (results.some((result) => result.ok)) await notifySafely(deps)
  return { results }
}

async function notifySafely(deps: MemoryToolDeps): Promise<void> {
  if (!deps.notify) return
  try {
    await deps.notify()
  } catch {
    // The store is the source of truth; a missed refresh is retried by the
    // next mutation or session creation.
  }
}

export async function runMemoryTool(
  name: string,
  args: unknown,
  deps: MemoryToolDeps,
): Promise<ToolCallResult> {
  if (!(MEMORY_TOOL_NAMES as readonly string[]).includes(name)) {
    return { text: `unknown tool: ${name}`, isError: true }
  }
  try {
    const tool = name as MemoryToolName
    let result: unknown
    switch (tool) {
      case "mem_index": {
        const index = await deps.store.readIndex()
        result = { index, chars: index.length, tokens: estimateTokens(index.length) }
        break
      }
      case "mem_find":
        result = await runFind(args, deps)
        break
      case "mem_write": {
        const entries = parseWrite(args)
        result = await runMutation(deps, () => deps.store.write(entries, "agent"))
        break
      }
      case "mem_update": {
        const updates = parseUpdate(args)
        result = await runMutation(deps, () => deps.store.update(updates, "agent"))
        break
      }
      case "mem_get": {
        const ids = parseIds(args)
        const fields = parseFields(args)
        const facts = await deps.store.get(ids)
        const picked: Array<Record<string, unknown>> = []
        let used = 0
        let truncated = false
        for (const fact of facts) {
          const value = pick(fact, fields)
          const size = bytes(value)
          if (used + size > MAX_RESULT_BYTES) {
            truncated = true
            break
          }
          used += size
          picked.push(value)
        }
        result = { facts: picked, ...(truncated ? { truncated: true } : {}) }
        break
      }
      case "mem_delete": {
        const input = parseDelete(args)
        const deleted = await deps.store.delete(input.ids, input.reason, "agent")
        const results = deleted.map(compactResult)
        if (results.some((entry) => entry.ok)) await notifySafely(deps)
        result = { results }
        break
      }
      case "mem_prune": {
        const input = parsePrune(args)
        const pruned = await deps.store.prune(input, "agent")
        if (!pruned.dryRun && pruned.deleted.length > 0) await notifySafely(deps)
        const truncated =
          pruned.candidates.length > 200 || pruned.deleted.length > 200
        result = {
          dryRun: pruned.dryRun,
          candidates: pruned.candidates.slice(0, 200),
          deleted: pruned.deleted.slice(0, 200),
          ...(truncated ? { truncated: true } : {}),
        }
        break
      }
      case "mem_stats": {
        const stats = await deps.store.stats()
        result = { ...stats, topics: stats.topics.slice(0, 100) }
        break
      }
    }
    return { text: json(result), isError: false }
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { text: `input: ${error.message}`, isError: true }
    }
    return { text: "internal: the memory tool failed", isError: true }
  }
}
