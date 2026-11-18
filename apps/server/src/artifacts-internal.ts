import { createHash, timingSafeEqual } from "node:crypto"
import type { Hono } from "hono"
import type { ArtifactWriteReceipt } from "@openchat/contracts"
import type { AppEnv } from "./app"
import { ARTIFACT_CREATE_LIMIT, ARTIFACT_CREATE_WINDOW_MS, artifactsAvailable } from "./artifacts"
import { ArtifactStore } from "./artifacts-store"
import type { EnvConfig } from "./env"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"
import { ARTIFACT_BODY_MAX_BYTES } from "./limits"
import { clientAddress } from "./middleware"
import { FixedWindowThrottle } from "./throttle"

/**
 * `POST /internal/artifacts`, the write path of the MCP tool. It sits outside
 * `/api/*` on purpose: the caller is a process next to OpenCode, not a browser
 * session, and the bearer token is the whole authentication. It writes through
 * the same `ArtifactStore` as the public route, so both share one layout, one
 * dedupe and one set of document rules.
 */

export const INTERNAL_ARTIFACTS_PATH = "/internal/artifacts"

/** Same fixed answers as the public route; no input is echoed. */
const UNAVAILABLE_MESSAGE = "Artifact storage is not configured"
const TOO_MANY_MESSAGE = "Too many artifacts"
const INVALID_BODY_MESSAGE = "body must be a JSON object"

export interface ArtifactInternalRouteDeps {
  config: EnvConfig
  /** Injected clock for `createdAt`; tests advance it. */
  now?: () => number
  /** Injected throttle; by default its own 20/min budget. */
  throttle?: FixedWindowThrottle
}

/** Constant-time bearer check; the hash hides the length as well. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  const provided = match?.[1]
  if (!provided) return false
  const left = createHash("sha256").update(provided).digest()
  const right = createHash("sha256").update(expected).digest()
  return timingSafeEqual(left, right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasJsonContentType(header: string | undefined): boolean {
  const type = header ?? ""
  return type.split(";")[0]?.trim().toLowerCase() === "application/json"
}

/**
 * Registers the internal write route. The request guards and the session
 * authentication do not run here: `/internal/*` is not `/api/*`, and a browser
 * never has the token.
 */
export function registerArtifactInternalRoute(
  app: Hono<AppEnv>,
  deps: ArtifactInternalRouteDeps,
): void {
  const { config } = deps
  const store = new ArtifactStore({ dir: config.ARTIFACTS_DIR, now: deps.now })
  const throttle =
    deps.throttle ??
    new FixedWindowThrottle({
      limit: ARTIFACT_CREATE_LIMIT,
      windowMs: ARTIFACT_CREATE_WINDOW_MS,
    })
  const token = config.ARTIFACT_INTERNAL_TOKEN

  app.post(INTERNAL_ARTIFACTS_PATH, async (c) => {
    c.header("Cache-Control", "no-store")
    if (!artifactsAvailable(config) || token.length === 0) {
      return jsonError(c, 503, "artifacts_unavailable", UNAVAILABLE_MESSAGE)
    }
    // Authentication comes before the budget: a wrong token must not let a
    // caller exhaust the writes the tool needs.
    if (!bearerMatches(c.req.header("authorization"), token)) {
      return jsonError(c, 401, "unauthorized", "Authentication required")
    }
    if (!hasJsonContentType(c.req.header("content-type"))) {
      return jsonError(c, 415, "unsupported_media_type", "Content-Type must be application/json")
    }

    const address = clientAddress(c, config.TRUST_PROXY)
    const status = throttle.check(address)
    if (status.limited) {
      c.header("Retry-After", String(status.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", TOO_MANY_MESSAGE)
    }

    const body = await readJson(c, ARTIFACT_BODY_MAX_BYTES)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c, ARTIFACT_BODY_MAX_BYTES)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "artifacts_invalid", INVALID_BODY_MESSAGE)
    }
    const draft = isRecord(body) ? body : {}
    const result = await store.create({ title: draft.title, html: draft.html })
    if (!result.ok) return jsonError(c, 400, "artifacts_invalid", result.reason)

    // Only an accepted write consumes the budget.
    throttle.record(address)
    const receipt: ArtifactWriteReceipt = {
      artifactID: result.artifact.id,
      title: result.artifact.title,
      bytes: result.artifact.bytes,
    }
    return c.json(receipt, 201)
  })
}
