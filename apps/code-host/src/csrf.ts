import { parseCookies } from "./session"

/**
 * Cross-origin evidence for state-changing requests.
 *
 * `oc_code` is `SameSite=Lax`, which is **site**-scoped: a sibling origin on
 * the same registrable domain (an artifact host, a second service, a subdomain
 * takeover) receives the cookie on a `POST`. The gate therefore demands
 * browser same-origin evidence for anything that is not a read.
 *
 * Reads are an allowlist, not a denylist: `GET`, `HEAD` and `OPTIONS` pass;
 * every other method — including `PROPFIND`, `PURGE` or a typo'd verb the
 * upstream might still dispatch — needs same-origin evidence.
 */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** What the request's own headers say about its origin. */
type Evidence = "same-origin" | "foreign" | "none"

function isCodeHostOrigin(value: string, codeHostOrigin: string): boolean {
  if (value === codeHostOrigin) return true
  // `Referer` carries a path; `Origin` is a bare origin. Compare origins so
  // both shapes are accepted and anything unparsable counts as foreign.
  try {
    return new URL(value).origin === codeHostOrigin
  } catch {
    return false
  }
}

/**
 * `Sec-Fetch-Site` is authoritative when present: only `same-origin` proves
 * same-origin. `Origin` and `Referer` are fallbacks for browsers and proxies
 * that omit it; an absent header is no evidence either way.
 */
function evidence(request: Request, codeHostOrigin: string): Evidence {
  let same = false

  const site = request.headers.get("sec-fetch-site")
  if (site !== null) {
    if (site.trim().toLowerCase() !== "same-origin") return "foreign"
    same = true
  }

  const origin = request.headers.get("origin")
  if (origin !== null) {
    if (!isCodeHostOrigin(origin, codeHostOrigin)) return "foreign"
    same = true
  }

  const referer = request.headers.get("referer")
  if (referer !== null) {
    if (!isCodeHostOrigin(referer, codeHostOrigin)) return "foreign"
    same = true
  }

  return same ? "same-origin" : "none"
}

/**
 * Whether the gate must refuse the request before it reaches upstream.
 *
 * - A read passes.
 * - An unsafe request with foreign evidence is refused, cookie or not.
 * - An unsafe request with same-origin evidence passes.
 * - An unsafe request with no evidence at all passes only when it carries no
 *   session cookie: `curl` and server-to-server clients never send `Origin`,
 *   while a browser sends it on every unsafe method. The exception is an
 *   end-of-life browser that omits `Origin` *and* ignores `SameSite`; that is
 *   the one shape that reaches upstream authenticated without evidence, so it
 *   is refused.
 */
export function refusesUnsafeRequest(
  request: Request,
  codeHostOrigin: string,
  sessionCookieName: string,
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false
  const kind = evidence(request, codeHostOrigin)
  if (kind === "foreign") return true
  if (kind === "same-origin") return false
  return parseCookies(request.headers.get("cookie"))[sessionCookieName] !== undefined
}
