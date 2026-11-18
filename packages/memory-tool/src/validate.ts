import type { MemoryTrust } from "@openchat/contracts"
import type { MemoryUpdateEntry, MemoryWriteEntry, PruneOptions } from "@openchat/memory-store"

/**
 * Hand-written argument validation. The MCP client sends arbitrary JSON; one
 * bad entry must produce a named error, not a crash or a half write.
 */

export class ToolInputError extends Error {}

const MAX_QUERIES = 20
const MAX_ENTRIES = 50
const MAX_IDS = 100

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolInputError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, name: string, max = 2_000): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`${name} must be a non-empty string`)
  }
  if (value.length > max) throw new ToolInputError(`${name} must be at most ${max} characters`)
  return value.trim()
}

function optionalString(value: unknown, name: string, max = 2_000): string | undefined {
  if (value === undefined) return undefined
  return string(value, name, max)
}

function stringArray(value: unknown, name: string, max: number, allowEmpty = false): string[] {
  if (!Array.isArray(value)) throw new ToolInputError(`${name} must be an array`)
  if (!allowEmpty && value.length === 0) throw new ToolInputError(`${name} must not be empty`)
  if (value.length > max) throw new ToolInputError(`${name} must contain at most ${max} entries`)
  return value.map((entry, index) => string(entry, `${name}[${index}]`, 200))
}

function trust(value: unknown, name: string): MemoryTrust | undefined {
  if (value === undefined) return undefined
  if (value === "explicit" || value === "observed" || value === "inferred") return value
  throw new ToolInputError(`${name} must be explicit, observed or inferred`)
}

function expires(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ToolInputError(`${name} must be an ISO timestamp or null`)
  }
  return value
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ToolInputError(`${name} must be a positive integer`)
  }
  return value
}

export interface FindInput {
  queries: string[]
  tags?: string[]
  since?: string
  limit?: number
}

export function parseFind(args: unknown): FindInput {
  const value = record(args, "arguments")
  const queries = stringArray(value.queries, "queries", MAX_QUERIES)
  const tags = value.tags === undefined ? undefined : stringArray(value.tags, "tags", 20)
  const since = optionalString(value.since, "since", 100)
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    throw new ToolInputError("since must be an ISO timestamp")
  }
  const limit = positiveInteger(value.limit, "limit")
  if (limit !== undefined && limit > 50) throw new ToolInputError("limit must be at most 50")
  return { queries, tags, since, limit }
}

export function parseWrite(args: unknown): MemoryWriteEntry[] {
  const value = record(args, "arguments")
  if (!Array.isArray(value.entries)) throw new ToolInputError("entries must be an array")
  if (value.entries.length === 0) throw new ToolInputError("entries must not be empty")
  if (value.entries.length > MAX_ENTRIES) {
    throw new ToolInputError(`entries must contain at most ${MAX_ENTRIES} items`)
  }
  return value.entries.map((raw, index) => {
    const entry = record(raw, `entries[${index}]`)
    const source = entry.source === undefined ? undefined : record(entry.source, `entries[${index}].source`)
    return {
      text: string(entry.text, `entries[${index}].text`),
      topic: string(entry.topic, `entries[${index}].topic`, 80),
      tags: entry.tags === undefined ? undefined : stringArray(entry.tags, `entries[${index}].tags`, 10, true),
      trust: trust(entry.trust, `entries[${index}].trust`),
      source:
        source === undefined
          ? undefined
          : {
              sessionID: source.sessionID === undefined ? "" : string(source.sessionID, "source.sessionID", 200),
              messageID: source.messageID === undefined ? "" : string(source.messageID, "source.messageID", 200),
              at: source.at === undefined ? undefined : string(source.at, "source.at", 100),
            },
      supersedes:
        entry.supersedes === undefined
          ? undefined
          : stringArray(entry.supersedes, `entries[${index}].supersedes`, 20, true),
      expiresAt: expires(entry.expiresAt, `entries[${index}].expiresAt`),
    }
  })
}

export function parseUpdate(args: unknown): MemoryUpdateEntry[] {
  const value = record(args, "arguments")
  if (!Array.isArray(value.updates)) throw new ToolInputError("updates must be an array")
  if (value.updates.length === 0) throw new ToolInputError("updates must not be empty")
  if (value.updates.length > MAX_ENTRIES) {
    throw new ToolInputError(`updates must contain at most ${MAX_ENTRIES} items`)
  }
  return value.updates.map((raw, index) => {
    const entry = record(raw, `updates[${index}]`)
    const status = entry.status
    if (
      status !== undefined &&
      status !== "active" && status !== "superseded" && status !== "expired" && status !== "deleted"
    ) {
      throw new ToolInputError(`updates[${index}].status is not a memory status`)
    }
    if (entry.confirm !== undefined && typeof entry.confirm !== "boolean") {
      throw new ToolInputError(`updates[${index}].confirm must be a boolean`)
    }
    return {
      id: string(entry.id, `updates[${index}].id`, 200),
      text: optionalString(entry.text, `updates[${index}].text`),
      topic: optionalString(entry.topic, `updates[${index}].topic`, 80),
      tags: entry.tags === undefined ? undefined : stringArray(entry.tags, `updates[${index}].tags`, 10, true),
      trust: trust(entry.trust, `updates[${index}].trust`),
      status,
      expiresAt: expires(entry.expiresAt, `updates[${index}].expiresAt`),
      confirm: entry.confirm,
    }
  })
}

export function parseIds(args: unknown, name = "ids"): string[] {
  const value = record(args, "arguments")
  return stringArray(value[name], name, MAX_IDS)
}

export function parseFields(args: unknown): string[] | undefined {
  const value = record(args, "arguments")
  return value.fields === undefined ? undefined : stringArray(value.fields, "fields", 20)
}

export function parseDelete(args: unknown): { ids: string[]; reason: string } {
  const value = record(args, "arguments")
  return {
    ids: stringArray(value.ids, "ids", MAX_IDS),
    reason: string(value.reason, "reason", 500),
  }
}

export function parsePrune(args: unknown): PruneOptions {
  const value = record(args, "arguments")
  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") {
    throw new ToolInputError("dryRun must be a boolean")
  }
  if (value.superseded !== undefined && typeof value.superseded !== "boolean") {
    throw new ToolInputError("superseded must be a boolean")
  }
  return {
    dryRun: value.dryRun,
    maxAgeDays: positiveInteger(value.maxAgeDays, "maxAgeDays"),
    superseded: value.superseded,
    maxBytes: positiveInteger(value.maxBytes, "maxBytes"),
  }
}
