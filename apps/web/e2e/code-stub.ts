/**
 * Stub Code host for the functional E2E suite and the ui-review screenshots.
 *
 * It stands in for `apps/code-host` so the browser-level contract of the Code
 * surface can be exercised without a real OpenCode: the BFF mints a real ticket
 * with `@openchat/code-ticket`, the app points its frame at this server through
 * `CODE_HOST_ORIGIN`, and the stub redeems the ticket exactly like the host
 * does (same secret, same audience = this origin).
 *
 * Routes:
 *
 * - `GET /__health`   `200 {"ok":true,"version":"2.3.0"}` — the BFF's probe.
 * - `GET /__auth`     ticket exchange. A valid ticket sets an `HttpOnly`
 *                     session cookie and answers `302` to `next`; anything
 *                     else answers `401` with a page that posts
 *                     `{type:"openchat:code-state",state:"unauthenticated"}` to
 *                     the app origin and carries a visible marker.
 * - `GET /__requests` the request log for assertions (see below).
 * - `GET /__upstream` the simulated OpenCode upstream (see below).
 * - everything else   a page with `data-testid="code-stub"` that echoes the
 *                     requested path, proving a deep link arrived.
 *
 * **Deliberate rejection switch.** A ticket is rejected when its validated
 * `next` path is exactly `/signed-out`, even if the ticket itself is valid. The
 * app reaches it by hand-typing `/code/signed-out`: the catch-all `/code/*`
 * route forwards `signed-out` as `next=/signed-out`, and the stub answers `401`
 * by design. No link, switch or fake-backend flow produces that path, so the
 * signed-out state cannot trigger by accident.
 *
 * **Two request kinds.** The stub also plays the OpenCode upstream: rendering an
 * authenticated page performs one loopback `GET /__upstream` carrying the same
 * `Authorization: Basic` header the real Code host injects before proxying.
 * `/__requests` labels it `kind: "upstream"` and every browser request
 * `kind: "browser"`, so a spec can prove the credential only ever travels
 * server-side. Only the header *shape* (present + scheme) is recorded; the
 * value is never stored, returned or rendered.
 *
 * **The session cookie is set but not enforced.** The app (`localhost:5173`) and
 * the stub (`127.0.0.1:8099`) are different sites, and a `SameSite=Lax` cookie
 * is not sent on a cross-site iframe request. The real host relies on a shared
 * registrable domain (see implementation 06); a loopback E2E run cannot, so the
 * stub keeps the exchange honest (it sets the cookie) without gating pages on a
 * cookie the browser would withhold.
 *
 * Runs under `tsx` because `@openchat/code-ticket` ships TypeScript sources with
 * extensionless relative imports, which plain Node ESM does not resolve.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { pathToFileURL } from "node:url"
import { readTicket } from "@openchat/code-ticket"

/** Fixed loopback origin; also the ticket audience and the frame's origin. */
export const CODE_STUB_ORIGIN = "http://127.0.0.1:8099"
/** Shared with the BFF through `CODE_TICKET_SECRET` in both Playwright configs. */
export const CODE_STUB_SECRET = "openchat-e2e-code-ticket-secret"
/**
 * The secret this process verifies with. The configs pass the same value to the
 * BFF and to the stub, so a drift shows up as a 401 instead of a silent pass.
 */
const TICKET_SECRET = process.env.CODE_TICKET_SECRET ?? CODE_STUB_SECRET
/** The only origin allowed to frame the stub and receive its state message. */
export const CODE_STUB_APP_ORIGIN = "http://localhost:5173"
/** The rejection switch documented above. */
export const CODE_STUB_REJECTED_NEXT = "/signed-out"
/** Must match the pinned OpenCode version so `/api/code/status` reports a match. */
const STUB_VERSION = "2.3.0"

const SESSION_COOKIE = "oc_code=e2e-stub-session; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600"
/** Fake upstream credential: never a real secret, never reaches the browser. */
const UPSTREAM_AUTHORIZATION = `Basic ${Buffer.from("opencode:e2e-stub").toString("base64")}`

interface AuthorizationShape {
  present: boolean
  /** The scheme only (`Basic`), never the credential. */
  scheme: string | null
}

interface RequestRecord {
  kind: "browser" | "upstream"
  method: string
  path: string
  authorization: AuthorizationShape
}

/** Bounded so a long browser session cannot grow the log without limit. */
const MAX_RECORDS = 400
const records: RequestRecord[] = []

function authorizationShape(value: string | string[] | undefined): AuthorizationShape {
  if (typeof value !== "string" || value.length === 0) return { present: false, scheme: null }
  const scheme = value.split(/\s+/, 1)[0] ?? ""
  return { present: true, scheme: /^[A-Za-z]+$/.test(scheme) ? scheme : "other" }
}

function record(kind: RequestRecord["kind"], request: IncomingMessage, path: string): void {
  records.push({
    kind,
    method: request.method ?? "GET",
    path,
    authorization: authorizationShape(request.headers.authorization),
  })
  if (records.length > MAX_RECORDS) records.shift()
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character)
}

/**
 * Mirrors the host's `safeNext`: an absolute path on this origin, never a
 * protocol-relative or scheme-bearing value. Anything else falls back to `/`.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/"
  if (/[\\\u0000-\u001f\u007f\s]/.test(raw)) return "/"
  if (/^\/[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return "/"
  return raw
}

function page(path: string, body = ""): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Stub Code host</title></head>
<body data-testid="code-stub">
<main>
<h1>Stub Code host</h1>
<p>Requested path: <code data-testid="code-path">${escapeHtml(path)}</code></p>
${body}
</main>
</body>
</html>`
}

function unauthorizedPage(path: string): string {
  return page(
    path,
    `<p data-testid="code-stub-unauthenticated" role="alert">Sign-in rejected</p>
<script>
if (window.parent !== window) {
  window.parent.postMessage(
    { type: "openchat:code-state", state: "unauthenticated" },
    ${JSON.stringify(CODE_STUB_APP_ORIGIN)},
  )
}
</script>`,
  )
}

function sendHtml(response: ServerResponse, status: 200 | 401, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  })
  response.end(html)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(body))
}

/**
 * The server-side hop a real Code host makes: one request to the upstream with
 * the injected Basic credential. It runs on loopback, so the browser never
 * sees it; the failure is ignored because the page is the point of the stub.
 */
async function pingUpstream(): Promise<void> {
  try {
    await fetch(`${CODE_STUB_ORIGIN}/__upstream`, {
      headers: { authorization: UPSTREAM_AUTHORIZATION, accept: "application/json" },
    })
  } catch {
    // The page still renders; /__requests simply has no upstream entry.
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", CODE_STUB_ORIGIN)
  const path = url.pathname
  request.resume()

  // Control endpoints are not part of the browser or upstream traffic the
  // specs assert on, so they are not recorded.
  if (path === "/__health") {
    sendJson(response, 200, { ok: true, version: STUB_VERSION })
    return
  }
  if (path === "/__requests") {
    sendJson(response, 200, { requests: records })
    return
  }
  if (path === "/__upstream") {
    record("upstream", request, path)
    sendJson(response, 200, { ok: true })
    return
  }

  record("browser", request, path)

  if (path === "/__auth") {
    const token = url.searchParams.get("ticket") ?? ""
    const next = safeNext(url.searchParams.get("next"))
    const claims = token
      ? readTicket(token, { secret: TICKET_SECRET, codeHost: CODE_STUB_ORIGIN })
      : null
    // Rejection switch: a valid ticket for this exact next is refused on
    // purpose, so the app's signed-out state is deterministic.
    if (!claims || next === CODE_STUB_REJECTED_NEXT) {
      sendHtml(response, 401, unauthorizedPage(next))
      return
    }
    response.writeHead(302, {
      location: next,
      "set-cookie": SESSION_COOKIE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    })
    response.end()
    return
  }

  await pingUpstream()
  sendHtml(response, 200, page(path))
}

export function startCodeStub(port = 8099): ReturnType<typeof createServer> {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      }
      response.end("stub failure")
    })
  })
  server.listen(port, "127.0.0.1")
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCodeStub()
  // Readiness is the BFF's own `/__health` probe, so no extra logging needed.
  console.log(`[code-stub] listening on ${CODE_STUB_ORIGIN}`)
}
