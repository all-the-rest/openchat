import type { Hono } from "hono"
import type { ChatBackend } from "@openchat/opencode"
import { createScheduleRequestSchema } from "@openchat/contracts"
import type { AppEnv } from "./app"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"

export interface TasksRouteDeps {
  backend: ChatBackend
}

/**
 * Schedules and background jobs. Authentication and the JSON content-type
 * guard run in the global `/api/*` middleware, exactly as for the chat routes.
 * A `BackendError` from the adapter is turned into a status by `app.onError`:
 * an unknown schedule id becomes 404, an unavailable host becomes 400.
 */
export function registerTasksRoutes(app: Hono<AppEnv>, deps: TasksRouteDeps): void {
  const { backend } = deps

  app.get("/api/sessions/:id/schedules", async (c) => {
    return c.json(await backend.listSchedules(c.req.param("id")))
  })

  app.post("/api/sessions/:id/schedules", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = createScheduleRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    const schedule = await backend.createSchedule({
      sessionID: c.req.param("id"),
      prompt: parsed.data.prompt,
      ends: parsed.data.ends,
    })
    return c.json(schedule, 201)
  })

  app.post("/api/schedules/:id/pause", async (c) => {
    return c.json(await backend.pauseSchedule(c.req.param("id")))
  })

  app.post("/api/schedules/:id/resume", async (c) => {
    return c.json(await backend.resumeSchedule(c.req.param("id")))
  })

  app.delete("/api/schedules/:id", async (c) => {
    await backend.deleteSchedule(c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/api/jobs", async (c) => {
    return c.json(await backend.listJobs())
  })
}
