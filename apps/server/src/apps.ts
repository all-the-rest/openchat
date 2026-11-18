import type { Context, Hono } from "hono"
import type { AppsResponse } from "@openchat/contracts"
import { BackendError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import type { AppEnv } from "./app"
import type { AppsCache } from "./apps-cache"
import type { EnvConfig } from "./env"
import { jsonError } from "./http"
import { clientAddress } from "./middleware"
import type { FixedWindowThrottle } from "./throttle"

/** Per-address action budget: 10 connect/disconnect calls in a fixed 60 s window. */
export const APPS_ACTION_LIMIT = 10
export const APPS_ACTION_WINDOW_MS = 60_000

/**
 * Host-side server names may legitimately contain spaces or non-ASCII letters
 * (`git hub`, `Über-Server`), so the shape check only keeps a hostile string
 * out of the upstream call: a decoded path segment may not carry a separator,
 * a control character or a URL delimiter. Authorization is the snapshot
 * comparison below, which matches the decoded name exactly.
 */
const APP_NAME_MAX_LENGTH = 128
const APP_NAME_FORBIDDEN = /[/\\\u0000-\u001f\u007f-\u009f?#]/

function isAppName(name: string): boolean {
  return name.length >= 1 && name.length <= APP_NAME_MAX_LENGTH && !APP_NAME_FORBIDDEN.test(name)
}

export interface AppsRouteDeps {
  backend: ChatBackend
  cache: AppsCache
  config: EnvConfig
  actionThrottle: FixedWindowThrottle
}

type AppAction = "connect" | "disconnect"

const UNAVAILABLE = "The app surface is unavailable"

function unavailable(c: Context<AppEnv>): Response {
  // Upstream error text, names and URLs never reach the client.
  return jsonError(c, 502, "apps_unavailable", UNAVAILABLE)
}

/**
 * Maps a rejected connect/disconnect onto the client's vocabulary. Only the
 * error code is used: the upstream message may carry a URL, a token or a
 * workspace path, so every body is a fixed string.
 */
function actionFailure(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof BackendError) {
    if (error.code === "conflict") {
      return jsonError(c, 409, "apps_disabled", "The server is disabled in the host configuration")
    }
    if (error.code === "not_found") {
      // The host dropped the server between the snapshot and the action.
      return jsonError(c, 404, "apps_unknown_server", "Unknown app server")
    }
    if (error.code === "invalid") {
      return jsonError(c, 400, "apps_invalid_name", "Invalid app server name")
    }
  }
  return unavailable(c)
}

/** One connect/disconnect handler; both share every guard. */
function actionHandler(
  deps: AppsRouteDeps,
  action: AppAction,
): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const address = clientAddress(c, deps.config.TRUST_PROXY)
    const throttle = deps.actionThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", "Too many app actions")
    }
    // Count every attempt, including an unknown name: the budget exists so the
    // route cannot be used as an amplifier, not only so valid calls are cheap.
    deps.actionThrottle.record(address)

    const name = c.req.param("name") ?? ""
    if (!isAppName(name)) {
      return jsonError(c, 404, "apps_unknown_server", "Unknown app server")
    }

    let snapshot: AppsResponse
    try {
      snapshot = await deps.cache.get()
    } catch {
      return unavailable(c)
    }
    // Without the capability there is no server to match: that is an upstream
    // problem, not an unknown name.
    if (!snapshot.available) return unavailable(c)
    if (!snapshot.servers.some((server) => server.name === name)) {
      return jsonError(c, 404, "apps_unknown_server", "Unknown app server")
    }

    try {
      if (action === "connect") await deps.backend.connectApp(name)
      else await deps.backend.disconnectApp(name)
    } catch (error) {
      return actionFailure(c, error)
    }
    // The status changed on the host, so the next read must not be the cached
    // snapshot the caller just acted on.
    deps.cache.invalidate()
    return c.body(null, 204)
  }
}

/** Registers `/api/apps`; the auth middleware has already run. */
export function registerAppsRoutes(app: Hono<AppEnv>, deps: AppsRouteDeps): void {
  app.get("/api/apps", async (c) => {
    c.header("Cache-Control", "no-store")
    try {
      return c.json((await deps.cache.get()) satisfies AppsResponse)
    } catch {
      return unavailable(c)
    }
  })

  app.post("/api/apps/:name/connect", actionHandler(deps, "connect"))
  app.post("/api/apps/:name/disconnect", actionHandler(deps, "disconnect"))
}
