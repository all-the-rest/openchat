/**
 * Cross-origin evidence for state-changing requests.
 *
 * `oc_code` is `SameSite=Lax`, which is **site**-scoped: a sibling origin on
 * the same registrable domain (an artifact host, a second service, a subdomain
 * takeover) receives the cookie on a `POST`. The gate therefore demands
 * browser same-origin evidence for unsafe methods before anything reaches
 * upstream. A browser always sends `Origin` on those methods, so allowing a
 * request with neither header cannot be turned into a bypass from a page; it
 * keeps `curl` and server-to-server clients working.
 */
export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Whether an unsafe request carries evidence of a foreign origin. A present
 * `Sec-Fetch-Site` other than `same-origin` or a present `Origin` that is not
 * the Code host origin is a rejection; both absent is allowed.
 */
export function isCrossOriginWrite(request: Request, codeHostOrigin: string): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false
  const site = request.headers.get("sec-fetch-site")
  if (site !== null && site.trim().toLowerCase() !== "same-origin") return true
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== codeHostOrigin) return true
  return false
}
