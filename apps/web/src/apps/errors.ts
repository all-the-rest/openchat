import { ApiError } from "../api/client"
import type { MessageKey, MessageVars } from "../i18n"

/** One translatable message, resolved with `t()` at render time. */
export interface AppNotice {
  key: MessageKey
  vars?: MessageVars
}

/**
 * Maps a failed connect/disconnect to a local message. The BFF's error text is
 * never shown: only the HTTP status and the stable `code` pick the wording.
 */
export function appActionError(error: unknown): AppNotice {
  if (!(error instanceof ApiError)) return { key: "apps.error.failed" }

  if (error.status === 429 || error.code === "too_many_requests") {
    return error.retryAfter === undefined
      ? { key: "apps.error.throttled" }
      : { key: "apps.error.throttledAfter", vars: { seconds: error.retryAfter } }
  }
  if (error.status === 404 || error.code === "apps_unknown_server") {
    return { key: "apps.error.unknownServer" }
  }
  if (error.status === 409 || error.code === "apps_disabled") {
    return { key: "apps.disabledNote" }
  }
  if (error.status === 502 || error.code === "apps_unavailable") {
    return { key: "apps.error.host" }
  }
  return { key: "apps.error.failed" }
}
