/**
 * `/api/memory` — the owner's view of the agent-managed store. All routes are
 * authenticated by the same `/api/*` guard as the rest of the BFF. The store owns
 * every path and validation decision; a failure is mapped to a stable code and
 * never echoes filesystem paths or secret text.
 */
import type { Context, Hono } from "hono"
import { MemoryStore } from "@openchat/memory-store"
import type { MemoryFact, WriteOutcome } from "@openchat/memory-store"
import {
  memoryCreateSchema,
  memoryDeleteSchema,
  memoryUpdateSchema,
} from "@openchat/contracts"
import type {
  MemoryAuditResponse,
  MemoryIndexResponse,
  MemoryListResponse,
} from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import { invalidMessage, jsonError } from "./http"
import type { MemoryInjector } from "./memory-inject"
import { estimateTokens } from "@openchat/memory-store"

const INVALID_BODY = "body must be a JSON object"
const UNKNOWN = "Unknown fact"

export interface MemoryRouteDeps {
  config: EnvConfig
  injector: MemoryInjector
}

function writeFailure(c: Context, outcome: Extract<WriteOutcome, { ok: false }>): Response {
  switch (outcome.code) {
    case "secret":
      return jsonError(c, 400, "memory_secret", outcome.message)
    case "instruction":
      return jsonError(c, 400, "memory_instruction", outcome.message)
    case "duplicate":
      return c.json(
        {
          error: {
            code: "memory_duplicate",
            message: outcome.message,
            ...(outcome.duplicateOf ? { duplicateOf: outcome.duplicateOf } : {}),
          },
        },
        409,
      )
    case "too-large":
      return jsonError(c, 413, "memory_too_large", outcome.message)
    case "capacity":
      return jsonError(c, 413, "memory_capacity", outcome.message)
    default:
      return jsonError(c, 400, "memory_invalid", outcome.message)
  }
}

/** Registers the authenticated memory routes; the store is BFF-side only. */
export function registerMemoryRoutes(app: Hono<AppEnv>, deps: MemoryRouteDeps): void {
  const store = new MemoryStore({ dir: deps.config.MEMORY_DIR })
  const { injector } = deps

  app.get("/api/memory", async (c) => {
    c.header("Cache-Control", "no-store")
    const [facts, stats] = await Promise.all([store.list(), store.stats()])
    return c.json({ facts, stats } satisfies MemoryListResponse)
  })

  app.get("/api/memory/index", async (c) => {
    c.header("Cache-Control", "no-store")
    const index = await store.index()
    return c.json({ index, tokens: estimateTokens(index) } satisfies MemoryIndexResponse)
  })

  app.get("/api/memory/audit", async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json({ entries: await store.auditTail() } satisfies MemoryAuditResponse)
  })

  app.get("/api/memory/export", async (c) => {
    c.header("Cache-Control", "no-store")
    const payload = await store.export()
    c.header("Content-Disposition", 'attachment; filename="memory.json"')
    c.header("X-Content-Type-Options", "nosniff")
    return c.json(payload)
  })

  app.post("/api/memory", async (c) => {
    c.header("Cache-Control", "no-store")
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = memoryCreateSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "memory_invalid", invalidMessage(parsed.error))
    }
    const outcomes = await store.write([parsed.data], c.get("user"))
    const outcome = outcomes[0]
    if (!outcome) return jsonError(c, 400, "memory_invalid", INVALID_BODY)
    if (!outcome.ok) return writeFailure(c, outcome)
    await injector.refreshAll()
    const facts = await store.list()
    const created = facts.find((fact) => fact.id === outcome.id)
    return c.json(created as MemoryFact, 201)
  })

  app.patch("/api/memory/:id", async (c) => {
    c.header("Cache-Control", "no-store")
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = memoryUpdateSchema.safeParse(
      body !== null && typeof body === "object" ? { ...(body as Record<string, unknown>), id: c.req.param("id") } : null,
    )
    if (!parsed.success) return jsonError(c, 400, "memory_invalid", invalidMessage(parsed.error))
    const outcome = (await store.update([parsed.data], c.get("user")))[0]
    if (!outcome) return jsonError(c, 400, "memory_invalid", INVALID_BODY)
    if (!outcome.ok) {
      return outcome.code === "unknown"
        ? jsonError(c, 404, "memory_unknown", UNKNOWN)
        : jsonError(c, 400, "memory_invalid", outcome.message)
    }
    await injector.refreshAll()
    const rows = await store.get([outcome.id])
    return c.json(rows[0] ?? null)
  })

  app.delete("/api/memory/:id", async (c) => {
    c.header("Cache-Control", "no-store")
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = memoryDeleteSchema.safeParse(
      body !== null && typeof body === "object"
        ? { ids: [c.req.param("id")], reason: (body as Record<string, unknown>).reason }
        : null,
    )
    if (!parsed.success) return jsonError(c, 400, "memory_invalid", invalidMessage(parsed.error))
    await store.delete(parsed.data.ids, parsed.data.reason, c.get("user"))
    await injector.refreshAll()
    return c.body(null, 204)
  })
}
