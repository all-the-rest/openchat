import type { Hono } from "hono"
import { BackendError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import { forkSessionRequestSchema } from "@openchat/contracts"
import type { SessionInfo } from "@openchat/contracts"
import type { AppEnv } from "./app"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"

export interface BranchRouteDeps {
  backend: ChatBackend
  /** Keeps the BFF's memory invalidator pointed at the new branch. */
  noteSession?: (sessionID: string) => void
}

/**
 * `POST /api/sessions/:id/fork` — creates a branch before one message.
 *
 * The original session is untouched. An unknown session is a `not_found`
 * (404 via the app error mapper); an unknown message is a malformed boundary
 * and answers `400 invalid_request` rather than pretending the fork exists.
 */
export function registerBranchRoute(app: Hono<AppEnv>, deps: BranchRouteDeps): void {
  app.post("/api/sessions/:id/fork", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = forkSessionRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }

    try {
      const session = await deps.backend.forkSession(
        c.req.param("id"),
        parsed.data.messageID,
      )
      deps.noteSession?.(session.id)
      return c.json(session satisfies SessionInfo)
    } catch (error) {
      // The backend says "invalid" for an unknown boundary message. A missing
      // session stays a `not_found` and is mapped by the app's error handler.
      if (error instanceof BackendError && error.code === "invalid") {
        return jsonError(c, 400, "invalid_request", error.message)
      }
      throw error
    }
  })
}
