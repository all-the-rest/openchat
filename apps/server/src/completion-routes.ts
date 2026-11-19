import type { Hono } from "hono"
import type { ChatBackend } from "@openchat/opencode"
import { formReplyRequestSchema, permissionReplyRequestSchema } from "@openchat/contracts"
import type {
  AgentInfo,
  FormsResponse,
  HostDefaultModelResponse,
  ModelInfo,
  PermissionsResponse,
} from "@openchat/contracts"
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
  // Read-only: the host-wide default is configuration, never a write target.
  app.get("/api/models/default", async (c) => {
    c.header("Cache-Control", "no-store")
    try {
      return c.json({ model: await backend.hostDefaultModel() } satisfies HostDefaultModelResponse)
    } catch {
      return jsonError(
        c,
        502,
        "model_default_unavailable",
        "The host default model could not be read",
      )
    }
  })
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

/**
 * Interactive question forms: the open list and one answer. A null-safe answer
 * record is required; the host decides whether a field was mandatory. The
 * backend maps an unknown form to `not_found` (404) and a form that already
 * left the open state to `conflict` (409).
 */
export function registerFormRoutes(app: Hono<AppEnv>, backend: ChatBackend): void {
  app.get("/api/sessions/:id/forms", async (c) => {
    const forms = await backend.listForms(c.req.param("id"))
    return c.json({ forms } satisfies FormsResponse)
  })

  app.post("/api/sessions/:id/forms/:formID", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = formReplyRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    await backend.replyForm(c.req.param("id"), c.req.param("formID"), parsed.data.answer)
    return c.json({ ok: true })
  })
}
