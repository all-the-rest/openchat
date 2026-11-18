import type { Hono } from "hono"
import { promptRequestSchema } from "@openchat/contracts"
import type { PromptResponse } from "@openchat/contracts"
import type { ChatBackend } from "@openchat/opencode"
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
import { clientAddress } from "./middleware"
import type { FixedWindowThrottle } from "./throttle"

export interface PromptRouteDeps {
  config: EnvConfig
  backend: ChatBackend
  promptThrottle: FixedWindowThrottle
}

/**
 * One prompt submission: throttle, validate, forward. The browser's persisted
 * model choice travels with it, including the optional variant.
 */
export function registerPromptRoute(app: Hono<AppEnv>, deps: PromptRouteDeps): void {
  const { config, backend, promptThrottle } = deps

  app.post("/api/sessions/:id/prompt", async (c) => {
    const address = clientAddress(c, config.TRUST_PROXY)
    const throttle = promptThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", "Too many prompts")
    }

    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = promptRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    // Count accepted submissions only; a rejected body must not consume the
    // caller's budget.
    promptThrottle.record(address)
    // Spec 03: one active run per session. A second send is queued rather than
    // rejected, so the BFF defaults to the queue delivery mode.
    const result = await backend.prompt(c.req.param("id"), {
      text: parsed.data.text,
      delivery: parsed.data.delivery ?? "queue",
      model: parsed.data.model,
      variant: parsed.data.variant,
      agent: parsed.data.agent,
    })
    const response: PromptResponse = { ok: true, messageID: result.messageID }
    if (result.queued) response.queued = true
    return c.json(response)
  })
}
