import type { MessageKey, MessageVars } from "../i18n"

export interface Notice {
  key: MessageKey
  vars?: MessageVars
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function retryAfterOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const value = (error as { retryAfter?: unknown }).retryAfter
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Stable BFF code → localized sentence; upstream text never reaches the UI. */
export function onboardingError(error: unknown): Notice {
  switch (codeOf(error)) {
    case "providers_unavailable":
      return { key: "firstRun.error.catalogue" }
    case "provider_models_unavailable":
      return { key: "firstRun.error.models" }
    case "provider_form_invalid":
    case "invalid_request":
      return { key: "firstRun.error.form" }
    case "provider_method_unsupported":
      return { key: "firstRun.error.unsupported" }
    case "provider_unknown":
    case "provider_method_unknown":
      return { key: "firstRun.error.catalogEntry" }
    case "provider_attempt_unknown":
      return { key: "firstRun.oauth.expired" }
    case "too_many_requests": {
      const seconds = retryAfterOf(error)
      return seconds === undefined
        ? { key: "firstRun.error.throttled" }
        : { key: "firstRun.error.throttledAfter", vars: { seconds } }
    }
    case "provider_connect_failed":
    case "provider_oauth_failed":
      return { key: "firstRun.error.connect" }
    default:
      return { key: "firstRun.error.unknown" }
  }
}

/**
 * Extracts the field name from the BFF's fixed `provider_form_invalid` text.
 * The value comes from our own message, not from upstream, so this stays a
 * display hint rather than a parsing contract.
 */
export function invalidFieldOf(error: unknown): string | null {
  if (codeOf(error) !== "provider_form_invalid") return null
  const message = error instanceof Error ? error.message : ""
  const match = /"([^"]+)"/.exec(message)
  return match?.[1] ?? null
}
