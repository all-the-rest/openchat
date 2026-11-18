import type { Hono } from "hono"
import { mintTicket } from "@openchat/code-ticket"
import type { CodeStatusResponse, CodeTicketResponse } from "@openchat/contracts"
import { PINNED_OPENCODE_VERSION } from "@openchat/opencode"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import { jsonError } from "./http"
import { clientAddress } from "./middleware"
import type { FixedWindowThrottle } from "./throttle"

/** Per-address mint budget: 20 tickets in a fixed 60 s window. */
export const CODE_TICKET_LIMIT = 20
export const CODE_TICKET_WINDOW_MS = 60_000
/** A polling UI must not reach the Code host more than once per 10 s. */
export const CODE_STATUS_CACHE_MS = 10_000

export interface CodeProbeResult {
  reachable: boolean
  /** Present only when the health body was `{ok:true, version}`. */
  version?: string
}

export type CodeProbe = (origin: string, timeoutMs: number) => Promise<CodeProbeResult>

export interface CodeRouteDeps {
  config: EnvConfig
  ticketThrottle: FixedWindowThrottle
  /** Injected for tests; the default probes `/__health` over `fetch`. */
  probe?: CodeProbe
  /** Status cache lifetime; injectable so tests need not wait 10 s. */
  statusCacheMs?: number
  /** Injected clock for the status cache. */
  now?: () => number
}

/** A health body is a small JSON object; anything larger is not trusted. */
const CODE_HEALTH_BODY_LIMIT_BYTES = 4_096
/** Mirrors the Code host's bound: a version is a short printable token. */
const CODE_VERSION_MAX_LENGTH = 64

const CONTROL_BYTES = /[\u0000-\u001f\u007f]/
const NON_PRINTABLE = /[^\x20-\x7e]/g

/**
 * Sanitises the `next` parameter to a path on the Code host. This is defence
 * in depth: the Code host re-validates the value (including after percent
 * decoding) and is authoritative, so the BFF deliberately does not duplicate
 * that decoding check. Anything questionable falls back to `/`.
 */
export function safeNext(raw: string | undefined): string {
  if (!raw) return "/"
  if (!raw.startsWith("/")) return "/"
  if (raw.startsWith("//")) return "/"
  if (raw.includes("\\")) return "/"
  if (CONTROL_BYTES.test(raw)) return "/"
  return raw
}

/**
 * Reads at most `limit` bytes of a probe body. A larger body is cancelled and
 * reported as untrusted instead of being parsed.
 */
async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  const body = response.body
  if (!body) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch {
    return null
  }
}

/**
 * A version is a short printable token. Control bytes are dropped and the
 * result is capped, so a hostile health answer cannot plant escapes in the
 * status response or make it unbounded.
 */
function printableVersion(raw: string): string | null {
  const cleaned = raw.replace(NON_PRINTABLE, "").trim()
  if (cleaned.length === 0) return null
  return cleaned.slice(0, CODE_VERSION_MAX_LENGTH)
}

/** The default probe: one GET of the Code host's `/__health`, bounded by a timer. */
export function createCodeProbe(fetchImpl: typeof fetch = fetch): CodeProbe {
  return async (origin, timeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${origin}/__health`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        redirect: "error",
      })
      if (!response.ok) return { reachable: false }
      const text = await readBoundedText(response, CODE_HEALTH_BODY_LIMIT_BYTES)
      if (text === null) return { reachable: false }
      let body: unknown
      try {
        body = JSON.parse(text) as unknown
      } catch {
        return { reachable: false }
      }
      if (typeof body !== "object" || body === null) return { reachable: false }
      const { ok, version } = body as Record<string, unknown>
      if (ok !== true || typeof version !== "string") return { reachable: false }
      const bounded = printableVersion(version)
      if (!bounded) return { reachable: false }
      return { reachable: true, version: bounded }
    } catch {
      // Timeout, transport failure, non-JSON body: all mean "not reachable".
      // Upstream error text never reaches the client.
      return { reachable: false }
    } finally {
      clearTimeout(timer)
    }
  }
}

function unconfiguredStatus(): CodeStatusResponse {
  return {
    configured: false,
    reachable: false,
    expectedVersion: PINNED_OPENCODE_VERSION,
    matches: false,
  }
}

function ticketUrl(origin: string, ticket: string, next: string): string {
  return `${origin}/__auth?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(next)}`
}

/** Registers `/api/code/*`; the auth middleware has already run. */
export function registerCodeRoutes(app: Hono<AppEnv>, deps: CodeRouteDeps): void {
  const { config, ticketThrottle } = deps
  const probe = deps.probe ?? createCodeProbe()
  const statusCacheMs = deps.statusCacheMs ?? CODE_STATUS_CACHE_MS
  const now = deps.now ?? (() => Date.now())

  let cached: { at: number; value: CodeStatusResponse } | undefined

  app.get("/api/code/ticket", (c) => {
    if (!config.CODE_HOST_ORIGIN) {
      return c.json({ error: "code_not_configured" }, 404)
    }

    const address = clientAddress(c, config.TRUST_PROXY)
    const throttle = ticketThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", "Too many ticket requests")
    }
    ticketThrottle.record(address)

    const next = safeNext(c.req.query("next"))
    const ticket = mintTicket({
      sub: c.get("user"),
      codeHost: config.CODE_HOST_ORIGIN,
      secret: config.CODE_TICKET_SECRET,
      ttlSeconds: config.CODE_TICKET_TTL_SECONDS,
    })
    c.header("Cache-Control", "no-store")
    return c.json({
      url: ticketUrl(config.CODE_HOST_ORIGIN, ticket, next),
    } satisfies CodeTicketResponse)
  })

  app.get("/api/code/status", async (c) => {
    c.header("Cache-Control", "no-store")
    if (!config.CODE_HOST_ORIGIN) {
      return c.json(unconfiguredStatus())
    }

    const at = now()
    if (cached && at - cached.at < statusCacheMs) {
      return c.json(cached.value)
    }

    const result = await probe(config.CODE_HOST_ORIGIN, config.CODE_STATUS_TIMEOUT_MS)
    const value: CodeStatusResponse =
      result.reachable && result.version
        ? {
            configured: true,
            reachable: true,
            version: result.version,
            expectedVersion: PINNED_OPENCODE_VERSION,
            matches: result.version === PINNED_OPENCODE_VERSION,
          }
        : {
            configured: true,
            reachable: false,
            expectedVersion: PINNED_OPENCODE_VERSION,
            matches: false,
          }
    cached = { at, value }
    return c.json(value)
  })
}
