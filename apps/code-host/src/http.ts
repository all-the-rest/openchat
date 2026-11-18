/** `Authorization: Basic …` for the upstream OpenCode API. Server-side only. */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

const SAFE_ADDRESS = /^[A-Za-z0-9.:_-]+$/

/**
 * Per-client label for logs. The socket address comes from the node adapter;
 * forwarding headers are client-controlled unless the operator sets
 * `TRUST_PROXY=1` (a reverse proxy that overwrites them sits in front).
 *
 * A forwarded value is client-controlled even then, so it is restricted to an
 * address/host charset before it can reach a log line; anything else is
 * labelled `unknown` rather than mangling or forging an attribution.
 */
export function clientAddress(
  request: Request,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded) return SAFE_ADDRESS.test(forwarded) ? forwarded : "unknown"
    const real = request.headers.get("x-real-ip")?.trim()
    if (real) return SAFE_ADDRESS.test(real) ? real : "unknown"
  }
  return remoteAddress || "local"
}
