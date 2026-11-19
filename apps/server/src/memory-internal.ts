/**
 * `POST /internal/memory/changed` — the MCP tool's best-effort notification
 * after a mutation. It sits outside `/api/*` like the artifact internal route:
 * the caller is a process next to OpenCode and the shared bearer token is the
 * whole authentication. No input is used; the BFF simply re-puts the index into
 * every session it is tracking.
 */
import type { Hono } from "hono"
import type { AppEnv } from "./app"
import { bearerMatches } from "./artifacts-internal"
import type { EnvConfig } from "./env"
import { jsonError } from "./http"
import type { MemoryInjector } from "./memory-inject"

export const INTERNAL_MEMORY_CHANGED_PATH = "/internal/memory/changed"

export interface MemoryInternalRouteDeps {
  config: EnvConfig
  injector: MemoryInjector
}

export function registerMemoryInternalRoute(
  app: Hono<AppEnv>,
  deps: MemoryInternalRouteDeps,
): void {
  app.post(INTERNAL_MEMORY_CHANGED_PATH, async (c) => {
    c.header("Cache-Control", "no-store")
    const token = deps.config.ARTIFACT_INTERNAL_TOKEN
    if (token.length === 0) {
      return jsonError(c, 503, "memory_unavailable", "Memory refresh is not configured")
    }
    if (!bearerMatches(c.req.header("authorization"), token)) {
      return jsonError(c, 401, "unauthorized", "Authentication required")
    }
    const refreshed = await deps.injector.refreshAll()
    return c.json({ refreshed })
  })
}
