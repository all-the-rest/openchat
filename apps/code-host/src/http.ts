/** `Authorization: Basic …` for the upstream OpenCode API. Server-side only. */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

/**
 * Per-client label for logs. The socket address comes from the node adapter;
 * forwarding headers are client-controlled unless the operator sets
 * `TRUST_PROXY=1` (a reverse proxy that overwrites them sits in front).
 */
export function clientAddress(
  request: Request,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded) return forwarded
    const real = request.headers.get("x-real-ip")?.trim()
    if (real) return real
  }
  return remoteAddress || "local"
}
