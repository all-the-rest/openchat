import type { Hono } from "hono"
import { FakeBackend, FakeHostSwitch } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import type { AppEnv } from "./app"
import { BODY_TOO_LARGE, INVALID_JSON, jsonError, payloadTooLarge, readJson } from "./http"

/**
 * Fake-mode browser test hooks, mounted only when `BACKEND_MODE=fake` alongside
 * the host outage switch. They let an E2E assert what the host recorded and
 * raise an approval without a real tool-using agent. No live BFF has these
 * routes, and the same authentication guard covers them.
 */
function probe(backend: ChatBackend): FakeBackend | null {
  if (backend instanceof FakeBackend) return backend
  if (backend instanceof FakeHostSwitch && backend.inner instanceof FakeBackend) {
    return backend.inner
  }
  return null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

export function registerFakeControlsRoutes(app: Hono<AppEnv>, backend: ChatBackend): void {
  app.get("/api/__fake/prompt/:id", (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(probe(backend)?.recordedPrompt(c.req.param("id")) ?? null)
  })

  app.get("/api/__fake/compactions/:id", (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(probe(backend)?.compactionRecord(c.req.param("id")) ?? null)
  })

  app.post("/api/__fake/compaction-failure", async (c) => {
    c.header("Cache-Control", "no-store")
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const record = body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {}
    const sessionID = text(record.sessionID)
    if (!sessionID) return jsonError(c, 400, "invalid_request", "sessionID is required")
    const fake = probe(backend)
    if (!fake) return jsonError(c, 404, "not_found", "No fake backend is attached")
    const times = typeof record.times === "number" ? record.times : 1
    fake.failNextCompaction(sessionID, times)
    return c.json(fake.compactionRecord(sessionID))
  })

  // Metadata only: the key's value is never part of the fake's record.
  app.get("/api/__fake/providers", (c) => {
    c.header("Cache-Control", "no-store")
    const fake = probe(backend)
    if (!fake) return c.json({ connects: [], oauthStarts: 0, oauthCancels: 0 })
    return c.json(fake.recordedProviders())
  })

  app.post("/api/__fake/permission", async (c) => {
    c.header("Cache-Control", "no-store")
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const record = body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {}
    const sessionID = text(record.sessionID)
    const tool = text(record.tool)
    const action = text(record.action)
    if (!sessionID || !tool || !action) {
      return jsonError(c, 400, "invalid_request", "sessionID, tool and action are required")
    }
    const fake = probe(backend)
    if (!fake) return jsonError(c, 404, "not_found", "No fake backend is attached")
    return c.json(await fake.askPermission(sessionID, tool, action))
  })
}
