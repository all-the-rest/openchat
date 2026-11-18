import type { Context, Hono } from "hono"
import type {
  ProviderConnectResponse,
  ProviderInfo,
  ProviderKeyConnectRequest,
  ProviderMethod,
  ProviderOAuthConnectRequest,
  ProviderOAuthStartResponse,
  ProviderOAuthStatusResponse,
  ProviderStatusResponse,
  ProvidersResponse,
} from "@openchat/contracts"
import {
  providerKeyConnectRequestSchema,
  providerOAuthCompleteRequestSchema,
  providerOAuthConnectRequestSchema,
} from "@openchat/contracts"
import { BackendError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import { BODY_TOO_LARGE, INVALID_JSON, invalidMessage, jsonError, payloadTooLarge, readJson } from "./http"
import { clientAddress } from "./middleware"
import { validateAnswerForm, validateKeyForm } from "./provider-form"
import type { FormProblem } from "./provider-form"
import type { FixedWindowThrottle } from "./throttle"

/** Per-address connection budget: 10 attempts in a fixed 60 s window. */
export const PROVIDER_CONNECT_LIMIT = 10
export const PROVIDER_CONNECT_WINDOW_MS = 60_000

export interface ProviderRouteDeps {
  backend: ChatBackend
  config: EnvConfig
  connectThrottle: FixedWindowThrottle
}

const UNAVAILABLE = "The provider catalogue could not be read from the host"

/** Stable browser-facing strings; upstream text is never forwarded. */
function formMessage(problem: FormProblem): string {
  switch (problem.reason) {
    case "required":
      return `The provider field "${problem.field}" is required`
    case "type":
      return `The provider field "${problem.field}" has the wrong type`
    case "range":
      return `The provider field "${problem.field}" is out of range`
    case "pattern":
      return `The provider field "${problem.field}" does not match its pattern`
    case "format":
      return `The provider field "${problem.field}" has the wrong format`
    case "option":
      return `The provider field "${problem.field}" is not one of the offered values`
    case "unknown":
      return `The provider form does not declare the field "${problem.field}"`
  }
}

function throttle(c: Context<AppEnv>, deps: ProviderRouteDeps): Response | null {
  const address = clientAddress(c, deps.config.TRUST_PROXY)
  const status = deps.connectThrottle.check(address)
  if (status.limited) {
    c.header("Retry-After", String(status.retryAfterSeconds))
    return jsonError(c, 429, "too_many_requests", "Too many provider connection attempts")
  }
  // Every attempt is counted, including one with an invalid body: the budget
  // exists so the route cannot be used as an amplifier.
  deps.connectThrottle.record(address)
  return null
}

async function loadProviders(deps: ProviderRouteDeps): Promise<ProviderInfo[] | null> {
  try {
    return await deps.backend.listProviders()
  } catch {
    return null
  }
}

function methodOf(
  provider: ProviderInfo,
  methodID: string | undefined,
  type: ProviderMethod["type"],
): ProviderMethod | null {
  if (methodID) {
    return provider.methods.find((entry) => entry.id === methodID) ?? null
  }
  return provider.methods.find((entry) => entry.type === type) ?? null
}

function unsupported(c: Context<AppEnv>, provider: ProviderInfo, method: ProviderMethod): Response {
  if (method.type === "command" || method.type === "external" || method.type === "env") {
    return jsonError(
      c,
      400,
      "provider_method_unsupported",
      "This provider method is configured on the host, not in the app",
    )
  }
  return jsonError(
    c,
    400,
    "provider_method_unsupported",
    `The provider "${provider.name}" does not offer this connection method`,
  )
}

async function startOAuth(
  c: Context<AppEnv>,
  deps: ProviderRouteDeps,
  body: ProviderOAuthConnectRequest,
): Promise<Response> {
  const providers = await loadProviders(deps)
  if (!providers) return jsonError(c, 502, "providers_unavailable", UNAVAILABLE)
  const provider = providers.find((entry) => entry.id === c.req.param("id"))
  if (!provider) return jsonError(c, 404, "provider_unknown", "Unknown provider")
  const method = methodOf(provider, body.methodID, "oauth")
  if (!method) return jsonError(c, 404, "provider_method_unknown", "Unknown provider method")
  if (method.type !== "oauth") return unsupported(c, provider, method)
  const validation = validateAnswerForm(method.form, body.answer)
  if (!validation.ok) {
    return jsonError(c, 400, "provider_form_invalid", formMessage(validation.problem))
  }
  try {
    const attempt = await deps.backend.startProviderOAuth({
      providerID: provider.id,
      methodID: method.id,
      answer: validation.value,
      label: body.label,
    })
    return c.json({ attempt } satisfies ProviderOAuthStartResponse)
  } catch {
    return jsonError(c, 502, "provider_oauth_failed", "The provider sign-in could not be started")
  }
}

/** Registers the provider onboarding routes; auth has already run. */
export function registerProviderRoutes(app: Hono<AppEnv>, deps: ProviderRouteDeps): void {
  app.get("/api/providers", async (c) => {
    c.header("Cache-Control", "no-store")
    const providers = await loadProviders(deps)
    if (!providers) return jsonError(c, 502, "providers_unavailable", UNAVAILABLE)
    return c.json(providers satisfies ProvidersResponse)
  })

  // Static route before the `:id` routes: the browser's verify step.
  app.get("/api/providers/status", async (c) => {
    c.header("Cache-Control", "no-store")
    try {
      const models = await deps.backend.listModels()
      return c.json({ models } satisfies ProviderStatusResponse)
    } catch {
      return jsonError(
        c,
        502,
        "provider_models_unavailable",
        "The model catalogue could not be read from the host",
      )
    }
  })

  app.post("/api/providers/:id/connect/key", async (c) => {
    const limited = throttle(c, deps)
    if (limited) return limited
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const parsed = providerKeyConnectRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }

    const providers = await loadProviders(deps)
    if (!providers) return jsonError(c, 502, "providers_unavailable", UNAVAILABLE)
    const provider = providers.find((entry) => entry.id === c.req.param("id"))
    if (!provider) return jsonError(c, 404, "provider_unknown", "Unknown provider")
    const method = methodOf(provider, parsed.data.methodID, "key")
    if (!method) return jsonError(c, 404, "provider_method_unknown", "Unknown provider method")
    if (method.type !== "key") return unsupported(c, provider, method)

    const validation = validateKeyForm(method.form, parsed.data.key, parsed.data.answer)
    if (!validation.ok) {
      return jsonError(c, 400, "provider_form_invalid", formMessage(validation.problem))
    }

    try {
      // The value is forwarded once and deliberately not kept here: no log
      // line, no error body and no response ever contains it.
      await deps.backend.connectProviderKey({
        providerID: provider.id,
        methodID: method.id,
        key: parsed.data.key,
        answer: validation.value,
        label: parsed.data.label,
      })
    } catch {
      return jsonError(c, 502, "provider_connect_failed", "The provider connection failed")
    }
    return c.json({ ok: true } satisfies ProviderConnectResponse)
  })

  app.post("/api/providers/:id/connect/oauth", async (c) => {
    const limited = throttle(c, deps)
    if (limited) return limited
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const parsed = providerOAuthConnectRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    return startOAuth(c, deps, parsed.data)
  })

  app.get("/api/providers/:id/connect/oauth/:attempt", async (c) => {
    try {
      const status = await deps.backend.providerOAuthStatus({
        providerID: c.req.param("id"),
        attemptID: c.req.param("attempt"),
      })
      return c.json({ status } satisfies ProviderOAuthStatusResponse)
    } catch (error) {
      if (error instanceof BackendError && error.code === "not_found") {
        return jsonError(c, 404, "provider_attempt_unknown", "Unknown provider sign-in attempt")
      }
      return jsonError(c, 502, "provider_oauth_failed", "The provider sign-in could not be read")
    }
  })

  app.post("/api/providers/:id/connect/oauth/:attempt/complete", async (c) => {
    const limited = throttle(c, deps)
    if (limited) return limited
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const parsed = providerOAuthCompleteRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }
    try {
      await deps.backend.completeProviderOAuth({
        providerID: c.req.param("id"),
        attemptID: c.req.param("attempt"),
        code: parsed.data.code,
      })
    } catch (error) {
      if (error instanceof BackendError && error.code === "not_found") {
        return jsonError(c, 404, "provider_attempt_unknown", "Unknown provider sign-in attempt")
      }
      return jsonError(c, 502, "provider_oauth_failed", "The provider sign-in could not be completed")
    }
    return c.json({ ok: true })
  })

  app.delete("/api/providers/:id/connect/oauth/:attempt", async (c) => {
    try {
      await deps.backend.cancelProviderOAuth({
        providerID: c.req.param("id"),
        attemptID: c.req.param("attempt"),
      })
    } catch (error) {
      if (error instanceof BackendError && error.code === "not_found") {
        return jsonError(c, 404, "provider_attempt_unknown", "Unknown provider sign-in attempt")
      }
      return jsonError(c, 502, "provider_oauth_failed", "The provider sign-in could not be cancelled")
    }
    return c.body(null, 204)
  })
}
