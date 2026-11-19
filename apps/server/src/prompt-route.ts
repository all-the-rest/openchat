import type { Hono } from "hono"
import { promptRequestSchema } from "@openchat/contracts"
import type { PromptResponse } from "@openchat/contracts"
import type { ChatBackend, PromptResult } from "@openchat/opencode"
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
import { clientModelRef, requestedModel } from "./fallback-config"
import type { ModelRef, TurnPolicy } from "@openchat/contracts"

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
 * The browser's picker value as a full `ModelRef` for attempt 1. A chain entry
 * with the same model id already names the provider, so the common case needs
 * no host read; anything else goes through the catalogue, because a model id
 * may itself contain a slash. A failed catalogue read leaves only composite
 * `providerID/modelID` values usable; otherwise the caller falls back to the
 * chain.
 */
async function resolveClientModel(
  backend: ChatBackend,
  policy: TurnPolicy,
  model: string | undefined,
  variant: string | undefined,
): Promise<ModelRef | undefined> {
  if (model === undefined) return undefined
  const entry = policy.chain.find((candidate) => candidate.modelID === model)
  if (entry !== undefined) {
    return {
      providerID: entry.providerID,
      modelID: entry.modelID,
      ...(entry.isFree === undefined ? {} : { isFree: entry.isFree }),
      ...(entry.contextLimit === undefined ? {} : { contextLimit: entry.contextLimit }),
      ...(variant === undefined ? {} : { variant }),
    }
  }
  let catalogue: Awaited<ReturnType<ChatBackend["listModels"]>>
  try {
    catalogue = await backend.listModels()
  } catch {
    return clientModelRef(model, variant)
  }
  return clientModelRef(model, variant, catalogue)
}

/**
 * One prompt submission: throttle, validate, forward. The browser's persisted
 * model choice travels with it, including the optional variant.
 */
export function registerPromptRoute(app: Hono<AppEnv>, deps: PromptRouteDeps): void {
  const { config, backend, promptThrottle } = deps
  // The resolved policy owns the cap when one is supplied; the environment
  // value is the fallback for a caller that registers the route without it.
  const softCap = new ContextSoftCap({
    backend,
    cap: deps.chatPolicy?.contextSoftCap ?? config.CHAT_CONTEXT_SOFT_CAP,
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
    const policy = deps.chatPolicy
    const fallback = deps.fallback
    // A configured chain makes the browser's picker the first request and the
    // chain only the tail. Without a chain the existing path is untouched: the
    // persisted `model` reaches the live adapter, which still validates it.
    const chainEngaged = policy !== undefined && policy.chain.length > 0
    const requested = chainEngaged
      ? ((await resolveClientModel(backend, policy, parsed.data.model, parsed.data.variant)) ??
        requestedModel(policy))
      : undefined
    const payload = {
      text: parsed.data.text,
      delivery: parsed.data.delivery ?? "queue",
      model: parsed.data.model,
      variant: parsed.data.variant,
      agent: parsed.data.agent,
      ...(requested ? { modelRef: requested } : {}),
    }
    const tracked = fallback !== undefined && policy !== undefined && requested !== undefined
    // Register before submitting: the host can emit text while the POST is
    // still open, and a turn the engine does not know would lose that evidence
    // and be retried after it already printed. The message id is adopted from
    // the response.
    if (tracked) fallback.begin(sessionID, payload, policy, requested)
    let result: PromptResult
    try {
      result = await backend.prompt(sessionID, payload)
    } catch (error) {
      // Nothing started, so no turn may linger and be retried later.
      if (tracked) fallback.abandon(sessionID)
      throw error
    }
    if (tracked) {
      // A queued send does not start a run; its registration must be dropped so
      // the active turn it replaced keeps its own state. `undefined` from the
      // live queue probe is "not queued": the prompt started the active run and
      // must stay tracked.
      if (result.queued === true) fallback.abandon(sessionID)
      else fallback.adopt(sessionID, result.messageID)
    }
    const response: PromptResponse = { ok: true, messageID: result.messageID }
    if (result.queued === true) response.queued = true
    if (decision.notice) response.notices = [decision.notice]
    return c.json(response)
  })
}
