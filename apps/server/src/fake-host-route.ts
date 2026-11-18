import type { Hono } from "hono"
import { FakeHostSwitch } from "@openchat/opencode"
import type { AppEnv } from "./app"
import { BODY_TOO_LARGE, INVALID_JSON, jsonError, payloadTooLarge, readJson } from "./http"

/** Fake-mode only: flips the simulated upstream for the host-status E2E. */
export const FAKE_HOST_PATH = "/api/__fake/host"

/**
 * Registers the outage switch for the browser E2E. It is mounted only when
 * `BACKEND_MODE=fake` (which `env.ts` refuses in production) and only for the
 * switchable fake, so a live BFF has no such route and no tunnel branch.
 */
export function registerFakeHostRoute(app: Hono<AppEnv>, backend: FakeHostSwitch): void {
  app.post(FAKE_HOST_PATH, async (c) => {
    c.header("Cache-Control", "no-store")
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    const down =
      typeof body === "object" && body !== null && "down" in body
        ? (body as { down?: unknown }).down
        : undefined
    if (typeof down !== "boolean") {
      return jsonError(c, 400, "invalid_request", "down must be a boolean")
    }
    backend.setHostDown(down)
    return c.json({ down })
  })
}
