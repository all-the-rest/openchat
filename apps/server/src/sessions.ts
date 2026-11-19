import type { Hono } from "hono"
import { MEMORY_INDEX_KEY } from "@openchat/contracts"
import type { ChatBackend } from "@openchat/opencode"
import {
  compactRequestSchema,
  createSessionRequestSchema,
  renameSessionRequestSchema,
} from "@openchat/contracts"
import type { InboxResponse, SessionInfo } from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"
import type { MemoryInvalidator } from "./memory-instructions"
import type { createMemoryStore } from "./memory-store"

export interface SessionMemory {
  store: ReturnType<typeof createMemoryStore>
  invalidator: MemoryInvalidator
}

export interface SessionRouteDeps {
  config: EnvConfig
  backend: ChatBackend
  memory: SessionMemory
  /** Drops server-owned turn state once the chat no longer exists. */
  forget?: (sessionID: string) => void
}

/**
 * Chat lifecycle: list, create, rename, delete, messages, inbox, interrupt and
 * compaction. Rename and delete live here so every session mutation goes
 * through one file; the memory index is planted on create and on discovery.
 */
export function registerSessionRoutes(app: Hono<AppEnv>, deps: SessionRouteDeps): void {
  const { config, backend, memory } = deps

  app.get("/api/sessions", async (c) => {
    const sessions = await backend.listSessions()
    // Sessions created in the Code UI (or by the host) never pass through the
    // create route below. Listing sessions is the bounded discovery point that
    // plants the memory index into those sessions; a session that already got
    // it is skipped, so this stays O(sessions), writes once and reuses the
    // list the route already paid for.
    await memory.invalidator.discover(sessions)
    return c.json(sessions satisfies SessionInfo[])
  })

  app.post("/api/sessions", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = createSessionRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    const session = await backend.createSession({
      title: parsed.data.title,
      directory: config.WORKSPACE_DIR,
      model: parsed.data.model,
      agent: parsed.data.agent,
    })
    memory.invalidator.noteSession(session.id)
    try {
      // The injected index is a convenience, never a reason to fail a create:
      // store and host errors are both ignored here.
      const value = memory.store.index().index
      await backend.putInstruction(session.id, MEMORY_INDEX_KEY, value)
      // Discovery must not plant a second copy into this session.
      memory.invalidator.markInjected(session.id)
    } catch {
      // Session creation succeeds even when the host has no instruction port.
      // Without the mark, the next discovery pass retries the index.
    }
    return c.json(session satisfies SessionInfo)
  })

  // Rename. The title is validated here; the host stores it as given and the
  // route answers the refreshed row so the sidebar and heading update at once.
  app.patch("/api/sessions/:id", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = renameSessionRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    const session = await backend.renameSession(c.req.param("id"), parsed.data.title)
    return c.json(session satisfies SessionInfo)
  })

  // Delete is state-changing, so the JSON content-type rule applies and the
  // client sends an empty object body. Unknown ids are a stable 404.
  app.delete("/api/sessions/:id", async (c) => {
    const sessionID = c.req.param("id")
    await backend.deleteSession(sessionID)
    // A deleted chat can never emit a terminal event again; keeping its
    // registration would leave the engine waiting on a turn that cannot finish.
    deps.forget?.(sessionID)
    return c.json({ ok: true })
  })

  app.get("/api/sessions/:id/messages", async (c) => {
    return c.json(await backend.listMessages(c.req.param("id")))
  })

  app.get("/api/sessions/:id/inbox", async (c) => {
    const entries = await backend.listInbox(c.req.param("id"))
    return c.json({ entries } satisfies InboxResponse)
  })

  // DELETE is state-changing, so the existing JSON content-type rule applies;
  // clients send `Content-Type: application/json` even though the body is empty.
  app.delete("/api/sessions/:id/inbox/:messageID", async (c) => {
    await backend.cancelQueued(c.req.param("id"), c.req.param("messageID"))
    return c.json({ ok: true })
  })

  app.post("/api/sessions/:id/interrupt", async (c) => {
    await backend.interrupt(c.req.param("id"))
    return c.json({ ok: true })
  })

  // Manual compaction. The host rejects a streaming session with `conflict`,
  // which `createApp` maps to 409; the transcript then renders the failure
  // event and offers a retry. The optional `id` makes a retried request
  // idempotent: the host requires the `msg_` prefix on that field.
  app.post("/api/sessions/:id/compact", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = compactRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    const outcome = await backend.compact(c.req.param("id"), {
      reason: "manual",
      id: parsed.data.id,
    })
    return c.json({ ok: true, status: outcome.status })
  })
}
