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
import { COMPACTION_WAIT_MS, ContextSoftCap } from "./context-cap"
import { clientAddress } from "./middleware"
import type { FixedWindowThrottle } from "./throttle"
import type { FallbackEngine } from "./fallback-engine"
import { requestedModel } from "./fallback-config"
import type { TurnPolicy } from "@openchat/contracts"

export interface PromptRouteDeps {
  config: EnvConfig
  backend: ChatBackend
  promptThrottle: FixedWindowThrottle
  /** How long a prompt waits for a compaction decision; tests shorten it. */
  compactionWaitMs?: number
  /** Model-fallback engine; tracks turns for retry decisions. */
  fallback?: FallbackEngine
  /** Resolved chat policy; empty chain disables fallback. */
  chatPolicy?: TurnPolicy
}

/**
 * One prompt submission: throttle, validate, forward. The browser's persisted
 * model choice travels with it, including the optional variant.
 */
export function registerPromptRoute(app: Hono<AppEnv>, deps: PromptRouteDeps): void {
  const { config, backend, promptThrottle } = deps
  const softCap = new ContextSoftCap({
    backend,
    cap: config.CHAT_CONTEXT_SOFT_CAP,
    waitMs: deps.compactionWaitMs ?? COMPACTION_WAIT_MS,
  })

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
    // The soft cap runs before admission: at/over the cap and idle, one
    // compaction is requested and awaited. A failure only adds a notice.
    const decision = await softCap.admit(c.req.param("id"))
    // Spec 03: one active run per session. A second send is queued rather than
    // rejected, so the BFF defaults to the queue delivery mode.
    const sessionID = c.req.param("id")
    const requested = deps.chatPolicy ? requestedModel(deps.chatPolicy) : undefined
    const payload = {
      text: parsed.data.text,
      delivery: parsed.data.delivery ?? "queue",
      model: parsed.data.model,
      variant: parsed.data.variant,
      agent: parsed.data.agent,
      ...(requested ? { modelRef: requested } : {}),
    }
    const result = await backend.prompt(sessionID, payload)
    // A queued send does not start a run; registering it would overwrite the
    // active turn's state (payload/requested) and the retry would re-send the
    // queued text. Only a prompt that actually starts a run becomes a turn.
    if (deps.fallback && deps.chatPolicy && requested && !result.queued) {
      deps.fallback.begin(sessionID, payload, deps.chatPolicy, requested, result.messageID)
    }
    const response: PromptResponse = { ok: true, messageID: result.messageID }
    if (result.queued) response.queued = true
    if (decision.notice) response.notices = [decision.notice]
    return c.json(response)
  })
}
