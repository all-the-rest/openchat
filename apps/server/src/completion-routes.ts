import type { Hono } from "hono"
import type { ChatBackend } from "@openchat/opencode"
import { permissionReplyRequestSchema } from "@openchat/contracts"
import type { AgentInfo, ModelInfo, PermissionsResponse } from "@openchat/contracts"
import type { AppEnv } from "./app"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"

/** The model and agent catalogues the browser pickers render. */
export function registerCatalogRoutes(app: Hono<AppEnv>, backend: ChatBackend): void {
  app.get("/api/models", async (c) => c.json(await backend.listModels() satisfies ModelInfo[]))
  app.get("/api/agents", async (c) => c.json(await backend.listAgents() satisfies AgentInfo[]))
}

/** One session's outstanding approvals and the three decisions. */
export function registerPermissionRoutes(app: Hono<AppEnv>, backend: ChatBackend): void {
  app.get("/api/sessions/:id/permissions", async (c) => {
    const requests = await backend.listPermissions(c.req.param("id"))
    return c.json({ requests } satisfies PermissionsResponse)
  })

  app.post("/api/sessions/:id/permissions/:requestID", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = permissionReplyRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    await backend.replyPermission(
      c.req.param("id"),
      c.req.param("requestID"),
      parsed.data.decision,
    )
    return c.json({ ok: true })
  })
}
