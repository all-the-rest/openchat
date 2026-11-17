import type { Hono } from "hono"
import type { ChatBackend } from "@openchat/opencode"
import { SEARCH_SOURCES } from "@openchat/contracts"
import type { SearchGroup, SearchResponse, SearchSource } from "@openchat/contracts"
import type { AppEnv } from "./app"
import { jsonError } from "./http"

const MAX_QUERY_LENGTH = 200
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

function isSource(value: string): value is SearchSource {
  return (SEARCH_SOURCES as readonly string[]).includes(value)
}

/** Parses `sources=a,b`; unknown names are a client error, not ignored. */
function parseSources(raw: string | undefined): SearchSource[] | undefined {
  if (raw === undefined) return [...SEARCH_SOURCES]
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return undefined
  const sources: SearchSource[] = []
  for (const part of parts) {
    if (!isSource(part)) return undefined
    if (!sources.includes(part)) sources.push(part)
  }
  return sources
}

/** Parses `limit`; absent means the default, anything else must be an integer. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return undefined
  return value
}

/**
 * One query, grouped by source. A requested source the deployment cannot query
 * is reported as `disabled` without a request; one that failed is `failed`.
 * Unrequested sources are never queried (FR-44).
 */
export function registerSearchRoute(app: Hono<AppEnv>, backend: ChatBackend): void {
  app.get("/api/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim()
    if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
      return jsonError(
        c,
        400,
        "invalid_request",
        `q must be between 1 and ${MAX_QUERY_LENGTH} characters`,
      )
    }

    const requested = parseSources(c.req.query("sources"))
    if (!requested) {
      return jsonError(
        c,
        400,
        "invalid_request",
        `sources must be a comma-separated list of: ${SEARCH_SOURCES.join(", ")}`,
      )
    }

    const limit = parseLimit(c.req.query("limit"))
    if (limit === undefined) {
      return jsonError(
        c,
        400,
        "invalid_request",
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
      )
    }

    const outcome = await backend.search({ query, sources: requested, limit })
    const groups: SearchGroup[] = requested.map((source) => {
      if (outcome.failed.includes(source)) {
        return { source, state: "failed", total: 0, hits: [] }
      }
      if (!outcome.available.includes(source)) {
        return { source, state: "disabled", total: 0, hits: [] }
      }
      // A backend that returned a hit for an unrequested source is ignored,
      // a provider may repeat a URL, so a group is deduped by id, and the
      // group is clamped to the limit whatever the upstream returned.
      const seen = new Set<string>()
      const hits = outcome.hits
        .filter((hit) => hit.source === source)
        .filter((hit) => {
          if (seen.has(hit.id)) return false
          seen.add(hit.id)
          return true
        })
        .slice(0, limit)
      return { source, state: "ok", total: hits.length, hits }
    })

    return c.json({
      query,
      available: outcome.available,
      groups,
    } satisfies SearchResponse)
  })
}
