import { basicAuthorization } from "./http"

/**
 * Symbol carrying the ordered `Content-Security-Policy` values. A CSP header
 * value is a comma-separated policy list in CSP3, so a joined value is legal
 * and equivalent; the symbol exists so a GET can write the nicer two-line
 * form. `Headers` itself only exposes the joined value, which is what HEAD
 * writes. Exported for the adapter and the tests.
 */
export const CSP_POLICIES = Symbol("openchat.csp-policies")

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
])

const DROPPED_INBOUND = new Set([
  "authorization",
  "cookie",
  "host",
  "expect",
  "upgrade",
  // Upstream CORS behaviour must not depend on the browser's origin, and
  // OpenCode has no business seeing which page embedded the frame.
  "origin",
])

export type Logger = (message: string) => void

export interface ProxyConfig {
  opencodeUrl: string
  username: string
  password: string
  appOrigin: string
}

export interface ProxyOptions {
  config: ProxyConfig
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  log?: Logger
}

export function isHopByHop(name: string, connectionHeader?: string | null): boolean {
  const lower = name.toLowerCase()
  if (HOP_BY_HOP.has(lower) || lower.startsWith("proxy-")) return true
  if (!connectionHeader) return false
  return connectionHeader
    .split(",")
    .some((token) => token.trim().toLowerCase() === lower)
}

function requestHeaders(request: Request, config: ProxyConfig): Headers {
  const headers = new Headers()
  const connection = request.headers.get("connection")
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (DROPPED_INBOUND.has(lower)) return
    if (isHopByHop(lower, connection)) return
    headers.set(name, value)
  })
  headers.set("authorization", basicAuthorization(config.username, config.password))
  // The proxy forwards the body as-is; asking for identity avoids a second
  // decompression round-trip and keeps `content-length` meaningful.
  headers.set("accept-encoding", "identity")
  return headers
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/")
}

interface ResponseParts {
  headers: Headers
  policies: string[]
}

function responseParts(upstream: Response, pathname: string, appOrigin: string): ResponseParts {
  const headers = new Headers()
  const policies: string[] = []
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? ""
  const isHtml = contentType.includes("text/html")
  const isApi = isApiPath(pathname)
  const isSse = contentType.includes("text/event-stream")
  // fetch decompresses the body itself but may leave the upstream encoding
  // header in place; forwarding it would describe the wrong bytes.
  const wasEncoded = upstream.headers.has("content-encoding")

  const connection = upstream.headers.get("connection")
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (isHopByHop(lower, connection)) return
    if (lower === "set-cookie") return
    if (lower === "authorization") return
    if (lower === "x-frame-options") return
    // An upstream redirect must not become an open redirect on the Code host
    // origin, and a Basic challenge must not raise the native dialog there.
    if (lower === "location") return
    if (lower === "www-authenticate") return
    // Pin the CORS surface shut: no readable cross-origin path for the
    // owner's session, whatever a future upstream sends by default.
    if (lower.startsWith("access-control-")) return
    if (lower === "content-security-policy") {
      policies.push(value)
      return
    }
    if (wasEncoded && (lower === "content-encoding" || lower === "content-length")) return
    if ((isHtml || isApi) && lower === "cache-control") return
    headers.set(name, value)
  })

  // Restriction only: upstream's policy stays byte-identical and the extra
  // value can narrow it, never widen it. Two comma-separated policies in one
  // header are equivalent; the symbol keeps the separate lines for GET.
  policies.push(`frame-ancestors ${appOrigin}`)
  for (const policy of policies) headers.append("content-security-policy", policy)

  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "no-referrer")
  if (isSse) {
    // A cached or buffered event stream is a broken event stream.
    headers.set("cache-control", "no-cache, no-transform")
    headers.set("x-accel-buffering", "no")
  } else if (isHtml || isApi) {
    headers.set("cache-control", "no-store")
  }
  return { headers, policies }
}

/**
 * Forwards one request to OpenCode with the Basic credential injected and
 * returns the upstream response with the Code host's header policy applied.
 * The body is never buffered; SSE chunks pass through as they arrive.
 */
export async function proxyRequest(request: Request, options: ProxyOptions): Promise<Response> {
  const { config } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  const target = `${config.opencodeUrl}${url.pathname}${url.search}`
  const method = request.method.toUpperCase()
  const hasBody = method !== "GET" && method !== "HEAD"

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(request, config),
    redirect: "manual",
    signal: request.signal,
  }
  if (hasBody && request.body) {
    init.body = request.body
    init.duplex = "half"
  }

  let upstream: Response
  try {
    upstream = await fetchImpl(target, init)
  } catch {
    // Never echo the target or the underlying error: both can carry
    // credentials or upstream topology.
    log("code host upstream request failed")
    return new Response(JSON.stringify({ error: "code_host_unavailable" }), {
      status: 502,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    })
  }

  const { headers, policies } = responseParts(upstream, url.pathname, config.appOrigin)

  const response = new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
  Object.defineProperty(response, CSP_POLICIES, {
    value: policies,
    enumerable: false,
  })
  return response
}
