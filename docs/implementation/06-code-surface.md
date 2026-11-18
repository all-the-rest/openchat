# 06 — Code surface: ticket, cookie and proxy

**Status:** 2026-11-18. Implements the Code host from issue #11
(`apps/code-host`) and the ticket primitive (`packages/code-ticket`). This is
the server half only: no BFF endpoint mints tickets yet and no page embeds the
frame. Those arrive in later slices; the contract below is what they will use.

Spec: [`../spec/13-code-surface.md`](../spec/13-code-surface.md). Architecture:
[`../architecture/06-code-surface.md`](../architecture/06-code-surface.md).

## Why the shell needs its own gate

The spike on pinned OpenCode 2.3.0 (`opencode serve`) found:

- `GET /` answers **200 without credentials**; only `/api/*` asks for Basic
  auth. Relying on upstream auth would publish the UI shell to anyone who can
  reach the Code host origin.
- The shell's CSP has no `frame-ancestors` and there is no `X-Frame-Options`,
  so the embedding app must add the restriction itself.
- The shell uses absolute paths (`/assets/…`, `/icons/…`, `/api/…`), so it
  must own an origin rather than live under a path prefix.
- The SPA calls `/api/*` on its own origin, which means the proxy has to
  forward the API (including the event stream), not just static files.

The Code host therefore authenticates every request itself and injects the
Basic credential server-side. A browser never sees that credential.

## Flow

```
app (BFF)                    Code host                        OpenCode
   │                            │                                │
   │ mintTicket(sub, codeHost)  │                                │
   │──── redirect ─────────────▶│ GET /__auth?ticket=…&next=/    │
   │                            │ readTicket + claim(jti)        │
   │                            │ 302 + Set-Cookie: oc_code      │
   │◀─────── 302 ───────────────│                                │
   │                            │ GET / (cookie)                 │
   │                            │──── Authorization: Basic ─────▶│
   │                            │◀────────── SPA / API ──────────│
   │                            │──── frame-ancestors appended ─▶│ browser
```

1. The app mints `v1.<claims>.<HMAC>` with `@openchat/code-ticket`. Claims are
   `{ sub, codeHost, exp, jti }`; `exp` is epoch seconds and the TTL is at most
   60 s. The signature covers `v1.<claims>`, so the version cannot be swapped.
2. The iframe/host navigates to `/__auth?ticket=…&next=<path>`. The token is
   verified before anything else: constant-time HMAC compare, expiry, and an
   exact `codeHost` audience match. Hostile input returns `null`, never throws.
3. Only after verification does the process-local `jti` cache claim the ticket
   (`readTicket` runs first, then `claim`). A second redemption is a 401 and
   sets no cookie.
4. On success the host sets `oc_code`, a host-only cookie with an HMAC-signed
   `{ sub, exp }` payload (key derived from `CODE_TICKET_SECRET`), and
   redirects to `next`.
5. Every other request — shell, `/api/*`, assets — requires that cookie and is
   proxied to `OPENCODE_URL` with `Authorization: Basic` injected.

`next` must be an absolute path on the Code host: it must start with `/`, must
not start with `//`, must not contain a backslash, control bytes, whitespace or
a scheme, and is checked again after percent-decoding for a structural escape.
Anything else falls back to `/` instead of failing the sign-in.

## Session cookie

```
oc_code=v1.<base64url({sub,exp})>.<HMAC>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>[; Secure]
```

- Host-only: **no `Domain` attribute**, so the cookie is never sent to the app
  or the artifact origin.
- `Secure` only when `COOKIE_SECURE` is on; production refuses a boot with it
  off unless `ALLOW_INSECURE_COOKIE=1` is set explicitly.
- `SameSite=Lax` is enough because the ticket exchange is a top-level
  redirect, including inside the frame.
- The cookie signing key is `HMAC-SHA256(CODE_TICKET_SECRET,
  "openchat:code-session")`, so tickets and cookies do not share a key.

Replay detection lives in `apps/code-host/src/replay.ts`: a bounded map
(10 000 entries) keyed by `jti`, pruned at `exp` on every claim. It is
process-local; the deployment runs one Code host process. If a second replica
is ever added, replay detection must move to shared storage or the ticket
audience must pin the replica.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Never expose the listener without the reverse proxy. |
| `PORT` | `8090` | Listener port. |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | Upstream OpenCode base URL; may carry a path, never credentials. |
| `OPENCODE_USERNAME` | `opencode` | Basic-auth username for upstream. |
| `OPENCODE_PASSWORD` | none | Basic-auth password for upstream. Required in production; never logged. |
| `CODE_HOST_ORIGIN` | `http://127.0.0.1:8090` | Public origin of this host; also the ticket audience. Required and `https:` in production. |
| `APP_ORIGIN` | `http://127.0.0.1:8787` | App origin; the only allowed `frame-ancestors` and the `postMessage` target. Required and `https:` in production. |
| `CODE_TICKET_SECRET` | ephemeral, generated | HMAC key for tickets and the derived cookie key. Required in production; a development boot warns and generates one. |
| `CODE_TICKET_TTL_SECONDS` | `60` | Configured ticket lifetime. Hard ceiling 60; development clamps with a warning, production refuses a larger value. |
| `CODE_SESSION_TTL_SECONDS` | `43200` | Code session cookie lifetime (12 h). |
| `COOKIE_SECURE` | off | Adds `Secure` to `oc_code`. Required in production unless explicitly opted out. |
| `ALLOW_INSECURE_COOKIE` | off | Explicit production opt-out from `COOKIE_SECURE=1`. |
| `TRUST_PROXY` | off | Trust `X-Forwarded-For`/`X-Real-IP` for the client label in failure logs. Leave off for a direct connection. |

Both origins are validated as bare origins: no path, query, fragment or
embedded credentials. Warnings and refusals name variables only, never values.

A production boot refuses when `CODE_TICKET_SECRET` or `OPENCODE_PASSWORD` is
missing, when either origin is missing or not `https:`, when `COOKIE_SECURE`
is off without `ALLOW_INSECURE_COOKIE=1`, or when
`CODE_TICKET_TTL_SECONDS > 60`.

## Header policy

| Header | Behaviour |
| --- | --- |
| `Content-Security-Policy` | Upstream's policy is forwarded byte-identical. A **second** header `frame-ancestors <APP_ORIGIN>` is appended. Two policies only narrow; replacing upstream's policy could widen it. |
| `X-Frame-Options` | Dropped; `frame-ancestors` is the control. |
| `X-Content-Type-Options` | `nosniff`, always. |
| `Referrer-Policy` | `no-referrer`, always. |
| `Cache-Control` (HTML) | `no-store`. |
| `Cache-Control` (`/api/*`) | `no-store`, except SSE (below). |
| `Cache-Control` (`/assets/*`) | Upstream's value is kept, usually `public, max-age=31536000, immutable`. |
| `Cache-Control` (SSE) | `no-cache, no-transform`. |
| `X-Accel-Buffering` (SSE) | `no`. |
| `Set-Cookie` (upstream) | Dropped. `oc_code` is the only cookie the browser may see. |
| Inbound `Authorization`, `Cookie`, `Host` | Stripped before forwarding. The proxy injects its own Basic credential. |
| Hop-by-hop headers | `connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-*` and anything named by `Connection`, in both directions. |
| Upstream `Authorization` | Also stripped from the response, so a misbehaving upstream cannot echo the credential to the client. |

Two CSP values cannot live in one header (the `Headers` API joins duplicates
with `, `, which is not a valid CSP list), so the proxy carries the ordered
values on a symbol and the node adapter writes them as separate header lines.
OpenCode 2.3 sends exactly one policy; if a future version sends several, they
are forwarded as one joined value plus the appended policy.

The `/assets/*` exception is deliberate. Content-hashed filenames are
immutable, carry nothing user-specific and are the bulk of the shell boot; a
`no-store` there would re-download the whole SPA on every load. HTML and the
API are always `no-store`, so a stale shell or another session's API payload
is never served from cache. Everything else keeps whatever upstream sends.

## Proxy and streaming

The proxy uses the platform `fetch` with the inbound body as a
`ReadableStream` (`duplex: "half"`) and returns the upstream body as a stream;
nothing is buffered. The node adapter pumps response chunks with
`response.write` and flushes headers before the body, so the first SSE frame
reaches the browser while upstream still holds the connection open. The
adapter's `close` handler aborts the lifecycle signal, which cancels the
upstream fetch when the browser goes away.

`accept-encoding: identity` is sent upstream: a compressed body would make the
proxy re-declare the wrong `content-length`. If an upstream ignores that and
still encodes, the encoding and length headers are dropped because `fetch`
already decoded the body.

Upstream failures return `502 {"error":"code_host_unavailable"}` with no
upstream URL, error text or credential. The failure is logged as a fixed
message.

## Routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `GET /__auth` | ticket | Verify, claim once, set `oc_code`, 302 to `next`; 401 page otherwise. |
| `GET /__health` | none | 200 `{"ok":true,"version":"…"}` from upstream `/api/info` (Basic auth, 2 s timeout), 502 `{"ok":false}` otherwise. No secret or upstream error text. |
| `GET /__sign-in` | none | The sign-in page. |
| everything else | `oc_code` | Proxy to `OPENCODE_URL`, `/api/*` included. |

A 401 is HTML for a navigation (`Accept: text/html` or
`Sec-Fetch-Mode: navigate`, outside `/api/*`) and
`{"error":"code_session_required"}` otherwise. The HTML page links to
`${APP_ORIGIN}/login` when standalone and, when framed, posts
`{ type: "openchat:code-state", state: "unauthenticated" }` with
`targetOrigin` set to `APP_ORIGIN` — never `"*"`.

`/__health` is unauthenticated on purpose: the app needs a cheap liveness probe
before it has a session. It reveals the upstream version only.

## Thrown-away alternatives

- **Serving OpenCode under the app's `/code/` prefix.** The shell references
  absolute `/assets` and `/api` paths, so every upgrade would need path
  rewriting and would collide with the BFF's own `/api`. Rejected in the
  architecture and confirmed by the spike.
- **Sharing the app's session cookie.** A `chat.example.com` cookie is not sent
  to `code.example.com`, and a registrable-domain cookie would also leak to the
  artifact origin. A one-time ticket keeps each origin's cookie separate.
- **Relying on OpenCode's Basic auth only.** The shell is unauthenticated
  upstream, so the UI would be public.
- **Putting the Basic credential in a URL or the browser.** It stays in the
  proxy process.

## WebSockets

Upgrade tunneling is out of scope for this slice. OpenCode 2.3's live channel
is SSE, which passes through unbuffered. If a later version adds a WebSocket
channel, the adapter must handle `upgrade` with a raw socket tunnel; the current
adapter answers the HTTP path only. This limitation is noted on issue #11.

## Tests

All tests run without a real OpenCode; stub upstreams listen on ephemeral
loopback ports.

| File | Covers |
| --- | --- |
| `packages/code-ticket/test/ticket.test.ts` | round trip, unique `jti`, TTL ceiling and refusal, wrong secret/audience/version, expiry boundary, tampered payload and signature, malformed input, bad signed claims. |
| `apps/code-host/test/env.test.ts` | defaults and warnings, explicit values, origin and URL validation, TTL clamp, every production refusal, no value in a warning. |
| `apps/code-host/test/auth.test.ts` | ticket single use, expired/tampered/wrong-audience/missing, cookie flags (incl. `Secure` and no `Domain`), open-redirect fallbacks, failure log without a token, sign-in page and both 401 shapes. |
| `apps/code-host/test/session.test.ts` | cookie round trip, wrong secret, expiry, tampering, attributes, clear-cookie, cookie parsing. |
| `apps/code-host/test/replay.test.ts` | first-claim wins, per-`jti` independence, expiry pruning, bounded growth. |
| `apps/code-host/test/proxy.test.ts` | gate before upstream, shell body, two CSP lines with byte-identical upstream policy, no `X-Frame-Options`, Basic injection, stripped cookies and echoed credential, `no-store` on `/api/*`, asset cache exception, POST body and query forwarding, 502 without detail, SSE first chunk while upstream is open. |
| `apps/code-host/test/health.test.ts` | version probe, Basic header, 401/malformed/unreachable upstream, no error text. |

## Not implemented in this slice

- No BFF endpoint mints a ticket; `packages/code-ticket` is the primitive the
  BFF slice will call.
- No UI: the Chat | Code switch, slim bar, `/code/*` deep links and the
  embedding frame are later slices.
- No rate limiting on ticket minting or the exchange. The architecture lists
  it; it belongs with the BFF mint endpoint and the deployment proxy.
- No WebSocket upgrade tunneling (see above).
- The deploy-time browser check that the real OpenCode shell frames correctly
  remains an operational step; the header path is covered by tests.

## BFF endpoints

**Status:** 2026-11-18. This section supersedes the "Not implemented" notes
above about a missing mint endpoint and missing rate limiting; both now exist
in `apps/server/src/code.ts`. The UI, deep links and the frame are still later
slices.

Both routes sit behind the existing `/api/*` authentication middleware and
answer `401` without a session.

### `GET /api/code/ticket?next=<path>`

Mints one single-use ticket with `@openchat/code-ticket` and returns the entry
URL for the Code host.

```json
{ "url": "https://code.example.com/__auth?ticket=…&next=%2Fworkspace%2Fx" }
```

- Unconfigured deployment (`CODE_HOST_ORIGIN` empty): `404
  {"error":"code_not_configured"}`. Nothing is minted and nothing is logged.
- Throttled per client address with `FixedWindowThrottle`: 20 mints in a fixed
  60 s window; the 21st answers `429` with `Retry-After`, like login.
- Claims: `sub` is the authenticated user, `codeHost` is `CODE_HOST_ORIGIN`,
  `exp` uses `CODE_TICKET_TTL_SECONDS` and `jti` is fresh per request.
- `Cache-Control: no-store`. The ticket appears only in this response body; it
  is never logged, stored or echoed elsewhere.

`next` is sanitised to a path on the Code host: non-empty, starts with `/`, not
`//`, no backslash, no control bytes and no scheme-like prefix; anything else
becomes `/`. **Division of responsibility:** the BFF sanitises as defence in
depth, the Code host re-validates the value (including its percent-decoding
structural check) and is authoritative. The BFF deliberately does not duplicate
the host's decoding check.

### `GET /api/code/status`

Probes the Code host's `/__health` server-side and compares its version with
`PINNED_OPENCODE_VERSION` from `@opencode/client` (exported by
`packages/opencode`).

```json
{ "configured": true, "reachable": true, "version": "2.3.0",
  "expectedVersion": "2.3.0", "matches": true }
```

- Unconfigured: `200 {configured:false, reachable:false,
  expectedVersion, matches:false}` without any probe.
- Reachable with `{ok:true, version}`: `reachable:true`, `version` set and
  `matches: version === expectedVersion`. A mismatch warns, never blocks.
- Any failure — transport error, non-2xx, timeout, malformed body — is
  `reachable:false`, `matches:false`, `version` omitted. The response never
  contains a ticket, the secret or upstream error text.
- The result is cached in memory for 10 s (`CODE_STATUS_CACHE_MS`, injectable),
  so a polling UI cannot hammer the Code host. `Cache-Control: no-store`.

### `InfoResponse.code`

`/api/info` now carries `code: { configured, expectedVersion }`. The UI reads it
from the single info response and hides the Chat | Code switch when
`configured` is false, without an extra request.

### Environment additions

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODE_HOST_ORIGIN` | empty | Code host origin and ticket audience. Empty disables the surface. When set it must be a bare `http(s)` origin (no path, query, fragment or credentials) and `https:` in production. |
| `CODE_TICKET_SECRET` | generated in development | Shared ticket key. Required in production when `CODE_HOST_ORIGIN` is set; a development boot warns and generates an ephemeral one. |
| `CODE_TICKET_TTL_SECONDS` | `60` | Mint TTL. Ceiling 60: development clamps with a warning, production refuses. |
| `CODE_STATUS_TIMEOUT_MS` | `2000` | `/__health` probe deadline; positive integer. |

Warnings and refusals name the variable only, never a value.

### Tests

| File | Covers |
| --- | --- |
| `apps/server/test/code.test.ts` | auth on both routes, unconfigured ticket/status/info, absolute URL and encoded `next`, `readTicket` claims (`sub`, `codeHost`, `exp` within TTL), `next` sanitisation table, fresh `jti` per mint, no ticket in status or logs, 21st mint `429` and window reset, matching/mismatching/unreachable/malformed/timeout status, 10 s probe cache and `/api/info` reporting. |
| `apps/server/test/env.test.ts` | origin validation, development secret generation, production refusal without a secret, https requirement, TTL clamp and refusal, timeout parsing. |
| `packages/opencode/test/pinned-version.test.ts` | `PINNED_OPENCODE_VERSION` against the package manifest and the installed `@opencode/client`. |

No test calls a real network host; the probe is injected.
