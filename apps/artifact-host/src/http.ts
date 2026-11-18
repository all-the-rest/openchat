import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { Hono } from "hono"
import { CSP_POLICIES } from "./app"
import type { PolicyCarrier } from "./app"

/**
 * Node header map for one response. Two rules matter:
 *
 * - the ordered CSP values travel on a response symbol, because `Headers` only
 *   exposes the comma-joined value; the array makes Node write one header line
 *   per policy, which is the shape the sandbox design documents;
 * - a `Set-Cookie` is dropped unconditionally. The artifact origin must never
 *   hand the browser a credential, whatever a future handler tries to do.
 */
export function nodeHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase()
    if (lower === "set-cookie") continue
    headers[lower] = value
  }
  const policies = (response as PolicyCarrier)[CSP_POLICIES]
  if (policies) headers["content-security-policy"] = [...policies]
  return headers
}

/** Bridges the node request/response pair to the Hono app. */
export function createNodeServer(app: Hono): Server {
  return createServer((request, response) => {
    handle(app, request, response).catch(() => {
      if (response.headersSent) {
        response.end()
        return
      }
      response.statusCode = 500
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.setHeader("cache-control", "no-store")
      response.end(JSON.stringify({ error: { code: "internal_error", message: "internal_error" } }))
    })
  })
}

/**
 * The host answers with at most a 1 MiB document, so buffering the body is
 * simpler than pumping and cannot pin a slow consumer. Request headers are not
 * forwarded on purpose: the host has no use for a cookie, an origin or an
 * `Authorization` header, and not reading them proves it.
 */
async function handle(
  app: Hono,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://artifact-host")
  const result = await app.fetch(
    new Request(url, { method: request.method ?? "GET", headers: {} }),
  )
  response.statusCode = result.status
  for (const [name, value] of Object.entries(nodeHeaders(result))) {
    response.setHeader(name, value)
  }
  if (!result.body) {
    response.end()
    return
  }
  response.end(Buffer.from(await result.arrayBuffer()))
}
