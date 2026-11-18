import type { Hono } from "hono"
import type { ArtifactMeta, ArtifactResponse, ArtifactsSurfaceInfo } from "@openchat/contracts"
import type { AppEnv } from "./app"
import { ArtifactStore } from "./artifacts-store"
import { ArtifactSigner } from "./artifacts-sign"
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
import type { FixedWindowThrottle } from "./throttle"

/** Per-address creation budget: 20 documents in a fixed 60 s window. */
export const ARTIFACT_CREATE_LIMIT = 20
export const ARTIFACT_CREATE_WINDOW_MS = 60_000
/** Newest-first list length; the store caps at 100 as well. */
export const ARTIFACT_LIST_LIMIT = 100

export interface ArtifactsRouteDeps {
  config: EnvConfig
  /** Creation throttle; tests inject a clock-bound instance. */
  createThrottle: FixedWindowThrottle
  /** Injected clock for URL expiry and `createdAt`; tests advance it. */
  now?: () => number
}

/** Fixed answers: neither an id nor any input is ever echoed back. */
const UNAVAILABLE_MESSAGE = "Artifact storage is not configured"
const UNKNOWN_MESSAGE = "Unknown artifact"
const TOO_MANY_MESSAGE = "Too many artifacts"
const INVALID_BODY_MESSAGE = "body must be a JSON object"

/**
 * The surface exists only when a public host base URL and a signing key are
 * both configured. Either alone is a half-configured deployment: the server
 * boots, hides the surface and says so once at boot.
 */
export function artifactsAvailable(config: EnvConfig): boolean {
  return Boolean(config.ARTIFACT_HOST_URL && config.ARTIFACT_SIGNING_KEY)
}

/** The `/api/info` form of the same check. */
export function artifactsSurface(config: EnvConfig): ArtifactsSurfaceInfo {
  return { available: artifactsAvailable(config) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * One response shape for all three routes: stored metadata plus a URL that is
 * signed now. Every read mints its own URL, so a page can be open longer than
 * one TTL and still refresh each artifact.
 */
function signedResponse(
  meta: ArtifactMeta,
  base: string,
  signer: ArtifactSigner,
): ArtifactResponse {
  return { ...meta, ...signer.mint(base, meta.id) }
}

/** Registers `/api/artifacts`; the auth middleware has already run. */
export function registerArtifactsRoutes(app: Hono<AppEnv>, deps: ArtifactsRouteDeps): void {
  const { config, createThrottle } = deps
  const store = new ArtifactStore({ dir: config.ARTIFACTS_DIR, now: deps.now })
  // Constructed only when both halves are configured: a signer with an empty
  // key can only produce URLs that 403 everywhere.
  const signer = artifactsAvailable(config)
    ? new ArtifactSigner({ key: config.ARTIFACT_SIGNING_KEY, now: deps.now })
    : undefined

  app.get("/api/artifacts", async (c) => {
    // Signed URLs and metadata are per-session; never let a cache hold them.
    c.header("Cache-Control", "no-store")
    if (!signer) {
      const empty: ArtifactResponse[] = []
      return c.json(empty)
    }
    const artifacts = await store.list({ limit: ARTIFACT_LIST_LIMIT })
    const base = config.ARTIFACT_HOST_URL
    return c.json(
      artifacts.map((meta) => signedResponse(meta, base, signer)) satisfies ArtifactResponse[],
    )
  })

  app.post("/api/artifacts", async (c) => {
    c.header("Cache-Control", "no-store")
    if (!signer) {
      return jsonError(c, 503, "artifacts_unavailable", UNAVAILABLE_MESSAGE)
    }
    const address = clientAddress(c, config.TRUST_PROXY)
    const throttle = createThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
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

    // Only an accepted write consumes the budget; a rejected body is a client
    // bug that never reaches the disk.
    createThrottle.record(address)
    return c.json(signedResponse(result.artifact, config.ARTIFACT_HOST_URL, signer), 201)
  })

  app.get("/api/artifacts/:id", async (c) => {
    c.header("Cache-Control", "no-store")
    if (!signer) {
      return jsonError(c, 503, "artifacts_unavailable", UNAVAILABLE_MESSAGE)
    }
    // `get()` rejects anything that is not a 64-character lowercase hex id, so
    // a shaped-but-unknown id and a hostile one look the same from outside.
    const meta = await store.get(c.req.param("id") ?? "")
    if (!meta) return jsonError(c, 404, "artifacts_unknown", UNKNOWN_MESSAGE)
    return c.json(signedResponse(meta, config.ARTIFACT_HOST_URL, signer))
  })
}
