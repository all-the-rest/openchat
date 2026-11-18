/**
 * Remote-host smoke check. It drives a running BFF over HTTP the same way a
 * browser does: health, login, `/api/info`, and the event stream. It works
 * against a deployment in another network or behind an SSH tunnel.
 *
 * The CLI entry point is `runCli` (wired to `smoke-cli.ts`); tests call
 * `runSmoke` and `runCli` with a stub server. The only server-side import is
 * the dependency-free `sse.ts`, so the tool stays a black-box client.
 */

import { SSE_RETRY_FRAME } from "./sse"

export interface SmokeCheck {
  name: string
  ok: boolean
  /** Human-readable evidence; never contains a credential or token. */
  detail: string
}

export interface SmokeOptions {
  /** BFF origin, e.g. `http://127.0.0.1:8787`. No trailing slash required. */
  baseUrl: string
  /** `OPENCHAT_PASSWORD` of the deployment under test. */
  password: string
  /** Basic-auth user; only used when login sets no session cookie. */
  user?: string
  /** How long to read the event stream. Default 2000 ms. */
  streamMs?: number
  /** Wait up to this long for one `: heartbeat` comment; 0 skips the wait. */
  heartbeatMs?: number
  /** Strings that must not appear in the responses this tool reads. */
  forbidden?: string[]
  /** Require `mode: "live"`; the default. A fake deployment is not a remote host. */
  requireLive?: boolean
  /** Deadline for one request (headers and body). Default 10 s. */
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface SmokeResult {
  checks: SmokeCheck[]
  failed: number
}

export const DEFAULT_STREAM_MS = 2_000
const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_USER = "owner"

function check(name: string, ok: boolean, detail: string): SmokeCheck {
  return { name, ok, detail }
}

function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

export function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Reads one chunk, or returns null when the window expires. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([reader.read(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Runs every check, in order. A failed check does not abort the run: the login
 * credential is reused, so the report shows all symptoms at once.
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const request = options.fetchImpl ?? fetch
  const base = originOf(options.baseUrl)
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const checks: SmokeCheck[] = []
  const bodies: Array<{ url: string; body: string }> = []
  let cookie = ""
  let authorization = ""

  const get = async (path: string, init: RequestInit = {}) => {
    const started = Date.now()
    const response = await request(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { response, ms: Date.now() - started }
  }

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {}
    if (cookie) headers.cookie = cookie
    if (authorization) headers.authorization = authorization
    return headers
  }

  try {
    const { response, ms } = await get("/healthz")
    const body = await response.text()
    bodies.push({ url: "/healthz", body })
    let mode = "unknown"
    let version = "unknown"
    let ok = false
    try {
      const parsed = JSON.parse(body) as { ok?: boolean; mode?: string; version?: string }
      ok = parsed.ok === true
      mode = parsed.mode ?? "unknown"
      version = parsed.version ?? "unknown"
    } catch {
      ok = false
    }
    const modeOk = options.requireLive === false || mode === "live"
    checks.push(
      check(
        "health",
        response.status === 200 && ok && modeOk,
        `HTTP ${response.status}, ok=${ok}, mode=${mode}, version=${version}, ${ms} ms` +
          (modeOk ? "" : " (a remote host must run BACKEND_MODE=live)"),
      ),
    )
  } catch (failure) {
    checks.push(check("health", false, `request failed: ${messageOf(failure)}`))
  }

  try {
    const user = options.user ?? DEFAULT_USER
    const { response, ms } = await get("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, password: options.password }),
    })
    const body = await response.text()
    bodies.push({ url: "/api/auth/login", body })
    const setCookie = response.headers.get("set-cookie") ?? ""
    cookie = setCookie.split(";")[0] ?? ""
    if (!cookie) {
      // `AUTH_MODE=basic` sets no cookie; the same password travels as Basic.
      authorization = `Basic ${Buffer.from(`${user}:${options.password}`).toString("base64")}`
    }
    const required = options.baseUrl.trim().toLowerCase().startsWith("https:")
      ? ["HttpOnly", "SameSite", "Secure"]
      : ["HttpOnly", "SameSite"]
    const flags = required.filter((flag) => setCookie.includes(flag))
    const sessionOk = cookie.length > 0 && flags.length === required.length
    const basicOk = cookie.length === 0 && authorization.length > 0
    checks.push(
      check(
        "login",
        response.status === 200 && (sessionOk || basicOk),
        `HTTP ${response.status}, ` +
          (response.status !== 200
            ? "no credential accepted"
            : cookie.length > 0
              ? sessionOk
                ? `session cookie with ${flags.join(", ")}`
                : `cookie is missing required flags (${flags.join(", ") || "none"})`
              : "no cookie (Basic fallback)") +
          `, ${ms} ms`,
      ),
    )
  } catch (failure) {
    checks.push(check("login", false, `request failed: ${messageOf(failure)}`))
  }

  try {
    const { response, ms } = await get("/api/info", { headers: authHeaders() })
    const body = await response.text()
    bodies.push({ url: "/api/info", body })
    let mode = "unknown"
    let workspace = "unknown"
    let dictation = "unknown"
    try {
      const parsed = JSON.parse(body) as {
        server?: { mode?: string; workspace?: string }
        dictation?: { enabled?: boolean }
      }
      mode = parsed.server?.mode ?? "unknown"
      workspace = parsed.server?.workspace ?? "unknown"
      dictation = parsed.dictation?.enabled ? "on" : "off"
    } catch {
      // The status check below reports the failure.
    }
    const modeOk = options.requireLive === false || mode === "live"
    checks.push(
      check(
        "info",
        response.status === 200 && modeOk,
        `HTTP ${response.status}, mode=${mode}, workspace=${workspace},` +
          ` dictation=${dictation}, ${ms} ms` +
          (modeOk ? "" : " (expected a live backend)"),
      ),
    )
  } catch (failure) {
    checks.push(check("info", false, `request failed: ${messageOf(failure)}`))
  }

  const streamMs = options.streamMs ?? DEFAULT_STREAM_MS
  const heartbeatMs = options.heartbeatMs ?? 0
  try {
    const controller = new AbortController()
    const headerTimer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    let response: Response
    try {
      response = await request(`${base}/api/events`, {
        headers: { ...authHeaders(), accept: "text/event-stream" },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(headerTimer)
    }
    const contentType = response.headers.get("content-type") ?? ""
    const buffering = response.headers.get("x-accel-buffering") ?? ""
    const cacheControl = response.headers.get("cache-control") ?? ""
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let raw = ""
    const until = started + Math.max(streamMs, heartbeatMs)
    while (reader && Date.now() < until) {
      const chunk = await readChunk(reader, Math.max(1, until - Date.now()))
      if (!chunk || chunk.done) break
      raw += decoder.decode(chunk.value, { stream: true })
      const retrySeen = raw.trimStart().startsWith(SSE_RETRY_FRAME)
      const heartbeatSeen = raw.includes(": heartbeat")
      if (retrySeen && (heartbeatMs === 0 || heartbeatSeen)) break
    }
    controller.abort()
    await reader?.cancel().catch(() => undefined)
    bodies.push({ url: "/api/events", body: raw })
    const retrySeen = raw.trimStart().startsWith(SSE_RETRY_FRAME)
    const heartbeatSeen = raw.includes(": heartbeat")
    const headersOk =
      contentType.startsWith("text/event-stream") &&
      buffering === "no" &&
      cacheControl.includes("no-cache") &&
      cacheControl.includes("no-transform")
    const streamOk =
      response.status === 200 &&
      headersOk &&
      retrySeen &&
      (heartbeatMs === 0 || heartbeatSeen)
    checks.push(
      check(
        "events",
        streamOk,
        `HTTP ${response.status}, content-type=${contentType || "missing"},` +
          ` x-accel-buffering=${buffering || "missing"},` +
          ` cache-control=${cacheControl || "missing"}, retry=${retrySeen},` +
          ` heartbeat=${heartbeatMs === 0 ? "not awaited" : heartbeatSeen},` +
          ` ${Date.now() - started} ms`,
      ),
    )
  } catch (failure) {
    checks.push(check("events", false, `stream failed: ${messageOf(failure)}`))
  }

  const forbidden = (options.forbidden ?? []).filter((entry) => entry.length > 0)
  const leaks = forbidden.filter((secret) => bodies.some(({ body }) => body.includes(secret)))
  checks.push(
    check(
      "no-secrets",
      leaks.length === 0,
      forbidden.length === 0
        ? "no forbidden strings configured"
        : leaks.length === 0
          ? `${forbidden.length} forbidden string(s) absent from ${bodies.length} response bodies`
          : `found ${leaks.length} forbidden string(s) in a response body`,
    ),
  )

  return { checks, failed: checks.filter((entry) => !entry.ok).length }
}
