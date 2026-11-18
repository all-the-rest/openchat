import { Hono } from "hono"
import { ArtifactSigner } from "@openchat/server/artifacts-sign"
import type { EnvConfig } from "./env"
import { ArtifactReader } from "./store"

/**
 * Symbol carrying the ordered `Content-Security-Policy` values. A CSP header
 * value is a comma-separated policy list in CSP3, so a joined value is legal
 * and enforced as an intersection; the symbol exists so the node adapter can
 * write the two policies as two header lines. Exported for the adapter and the
 * tests.
 */
export const CSP_POLICIES = Symbol("openchat.artifact-csp-policies")

export type PolicyCarrier = Response & { readonly [CSP_POLICIES]?: string[] }

/**
 * The second policy keeps the document sandboxed even if a future embed
 * forgets the iframe attribute. `allow-same-origin` is deliberately absent:
 * with `allow-scripts` it would give the artifact its origin's storage and
 * cookies.
 */
export const SANDBOX_POLICY = "sandbox allow-scripts"

/**
 * Default deny, inline script and style only, no remote image, font or media
 * source (which would reopen an exfiltration channel), no network, no
 * navigation and only the chat origin as a framer.
 */
export function documentPolicy(frameAncestors: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ")
}

export interface AppOptions {
  config: EnvConfig
  /** Epoch milliseconds; injected by tests for URL expiry. */
  now?: () => number
  /** Injected for tests; defaults to the configured directory. */
  reader?: ArtifactReader
}

const ERROR_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
}

/**
 * Local error answer. Built here so no file path, id or key fragment can reach
 * the client; the 403 does not reveal whether the artifact exists.
 */
function errorResponse(status: 403 | 404, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: ERROR_HEADERS,
  })
}

/**
 * The artifact origin: one unsigned liveness route and one signed byte route.
 * No auth, no cookie, no CORS, no redirect — a request either carries a valid
 * signature or gets nothing.
 */
export function createApp(options: AppOptions): Hono {
  const { config } = options
  const now = options.now ?? Date.now
  const reader = options.reader ?? new ArtifactReader(config.ARTIFACTS_DIR)
  const signer = new ArtifactSigner({ key: config.ARTIFACT_SIGNING_KEY, now })
  const policy = documentPolicy(config.ARTIFACT_FRAME_ANCESTORS)

  const app = new Hono()

  app.get("/healthz", (c) => c.json({ status: "ok" }))

  app.get("/a/:id", async (c) => {
    const id = c.req.param("id") ?? ""
    const exp = c.req.query("exp") ?? ""
    const sig = c.req.query("sig") ?? ""

    // Signature first, bytes second: an unsigned request must never cause a
    // filesystem read, and it must not learn whether the id exists.
    if (!signer.verify(id, exp, sig)) {
      return errorResponse(403, "artifact_forbidden")
    }

    const bytes = await reader.read(id)
    if (!bytes) return errorResponse(404, "artifact_not_found")

    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      // The id is the SHA-256 of these bytes, so no rehash is needed.
      etag: `"sha256:${id}"`,
    })
    headers.append("content-security-policy", policy)
    headers.append("content-security-policy", SANDBOX_POLICY)

    const response = new Response(new Uint8Array(bytes), { status: 200, headers })
    Object.defineProperty(response, CSP_POLICIES, {
      value: [policy, SANDBOX_POLICY],
      enumerable: false,
    })
    return response
  })

  // No default Hono page: the host answers with a small JSON body, a 404 and
  // no artifact headers, so an unknown path reveals nothing else.
  app.notFound(() => errorResponse(404, "not_found"))

  return app
}
