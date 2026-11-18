import type { Hono } from "hono"
import {
  memoryCreateSchema,
  memoryDeleteSchema,
  memoryUpdateSchema,
} from "@openchat/contracts"
import type {
  MemoryIndexResponse,
  MemoryListResponse,
} from "@openchat/contracts"
import type { EnvConfig } from "./env"
import type { AppEnv } from "./app"
import type { MemoryService } from "./memory-service"
import type { MemoryStore } from "@openchat/memory-store"
import { bearerMatches } from "./artifacts-internal"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"

/**
 * Owner-facing memory routes plus the internal change notification. The store
 * is the BFF's; the agent writes through the MCP server and this page is the
 * owner override (browse, edit, delete, export, audit).
 */

export const INTERNAL_MEMORY_CHANGED_PATH = "/internal/memory/changed"

export interface MemoryRouteDeps {
  config: EnvConfig
  store: MemoryStore
  service: MemoryService
}

const BAD_INPUT = "Memory was not changed: the write was rejected"
const UNAVAILABLE = "Memory is not configured"

function errorStatus(code: string): 400 | 404 {
  return code === "memory_not_found" ? 404 : 400
}

function registerOwnerRoutes(app: Hono<AppEnv>, deps: MemoryRouteDeps): void {
  const { store } = deps

  app.get("/api/memory", async (c) => {
    c.header("Cache-Control", "no-store")
    const body: MemoryListResponse = { facts: await store.list(), stats: await store.stats() }
    return c.json(body)
  })

  app.get("/api/memory/index", async (c) => {
    c.header("Cache-Control", "no-store")
    const index = await store.readIndex()
    const body: MemoryIndexResponse = {
      index,
      chars: index.length,
      tokens: Math.ceil(index.length / 4),
    }
    return c.json(body)
  })

  app.get("/api/memory/audit", async (c) => {
    c.header("Cache-Control", "no-store")
    const limit = Number(c.req.query("limit") ?? "40")
    return c.json({ entries: await store.audit(Number.isFinite(limit) ? limit : 40) })
  })

  app.get("/api/memory/export", async (c) => {
    c.header("Cache-Control", "no-store")
    c.header("Content-Disposition", 'attachment; filename="openchat-memory.json"')
    return c.json(await store.export())
  })

  app.post("/api/memory", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const parsed = memoryCreateSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "memory_invalid", invalidMessage(parsed.error))
    }
    const input = parsed.data
    const result = await store.write(
      [
        {
          text: input.text,
          topic: input.topic,
          tags: input.tags,
          trust: input.trust,
          source: {
            sessionID: input.source?.sessionID ?? "",
            messageID: input.source?.messageID ?? "",
          },
          expiresAt: input.expiresAt,
        },
      ],
      "owner",
    )
    const item = result[0]
    if (!item) return jsonError(c, 500, "internal_error", "Memory write failed")
    if (!item.ok) return jsonError(c, errorStatus(item.code), item.code, BAD_INPUT)
    return c.json({ fact: item.fact }, 201)
  })

  app.patch("/api/memory/:id", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const parsed = memoryUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "memory_invalid", invalidMessage(parsed.error))
    }
    const result = await store.update(
      [{ id: c.req.param("id"), ...parsed.data }],
      "owner",
    )
    const item = result[0]
    if (!item) return jsonError(c, 500, "internal_error", "Memory update failed")
    if (!item.ok) return jsonError(c, errorStatus(item.code), item.code, BAD_INPUT)
    return c.json({ fact: item.fact })
  })

  app.delete("/api/memory/:id", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const parsed = memoryDeleteSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "memory_invalid", invalidMessage(parsed.error))
    }
    const result = await store.delete([c.req.param("id")], parsed.data.reason, "owner")
    const item = result[0]
    if (!item) return jsonError(c, 500, "internal_error", "Memory delete failed")
    if (!item.ok) return jsonError(c, errorStatus(item.code), item.code, BAD_INPUT)
    return c.json({ deleted: true })
  })
}

/** Same bearer token as the artifact tool; a browser never has it. */
function registerInternalRoute(app: Hono<AppEnv>, deps: MemoryRouteDeps): void {
  const token = deps.config.ARTIFACT_INTERNAL_TOKEN
  app.post(INTERNAL_MEMORY_CHANGED_PATH, async (c) => {
    c.header("Cache-Control", "no-store")
    if (token.length === 0) return jsonError(c, 503, "memory_unavailable", UNAVAILABLE)
    if (!bearerMatches(c.req.header("authorization"), token)) {
      return jsonError(c, 401, "unauthorized", "Authentication required")
    }
    const result = await deps.service.refresh()
    return c.json(result, 202)
  })
}

export function registerMemoryRoutes(app: Hono<AppEnv>, deps: MemoryRouteDeps): void {
  registerOwnerRoutes(app, deps)
  registerInternalRoute(app, deps)
}
