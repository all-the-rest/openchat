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
   │                            │ 302 + Set-Cookie: session      │
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
   verified before anything else: constant-time HMAC compare, expiry, a ceiling
   of `exp ≤ now + 60 s + 60 s skew` (so the mint limit is enforced by the
   receiver too), and an exact `codeHost` audience match. Hostile input returns
   `null`, never throws.
3. Only after verification does the process-local `jti` cache claim the ticket
   (`readTicket` runs first, then `claim`). A second redemption is a 401 and
   sets no cookie.
4. On success the host sets the session cookie (`__Host-oc_code` when secure,
   plain `oc_code` in development), a host-only cookie with an HMAC-signed
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
__Host-oc_code=v1.<base64url({sub,exp})>.<HMAC>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>; Secure
```

- **Name.** `__Host-oc_code` when `COOKIE_SECURE` is on, the plain `oc_code`
  in development. The gate reads exactly one name — the one matching the
  configuration, never both — so a sibling subdomain that sets
  `Domain=example.com; oc_code=…` cannot shadow the real cookie. `__Host-`
  also makes browsers reject a cookie with a `Domain` attribute at all.
- Host-only: **no `Domain` attribute**, so the cookie is never sent to the app
  or the artifact origin.
- `Secure` only when `COOKIE_SECURE` is on; production refuses a boot with it
  off unless `ALLOW_INSECURE_COOKIE=1` is set explicitly.
- `SameSite=Lax` keeps the cookie on the top-level ticket redirect, including
  inside the frame. It is **not** a CSRF control: it is site-scoped, not
  origin-scoped, so a sibling origin on the same registrable domain receives
  the cookie on a cross-origin `POST`.
- The cookie signing key is `HMAC-SHA256(CODE_TICKET_SECRET,
  "openchat:code-session")`, so tickets and cookies do not share a key.

### Cross-origin writes

The gate rejects an unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) before it
reads the cookie or touches upstream when either

- `Sec-Fetch-Site` is present and is not `same-origin`, or
- `Origin` is present and is not `CODE_HOST_ORIGIN`.

A request with neither header is allowed: `curl` and server-to-server clients
never sent one, and a browser always sends `Origin` on those methods, so a page
cannot omit it to bypass the check. The 403 is
`{"error":"cross_origin_forbidden"}` with `no-store`, built locally so no
upstream byte can reach the browser; the log line carries the client
attribution only. Reads stay allowed — without CORS the browser cannot read the
response, and the embedded SPA needs them. `CODE_HOST_ORIGIN` must be the
origin the browser actually uses, scheme and port included, or legitimate
writes are rejected.

Replay detection lives in `apps/code-host/src/replay.ts`: a bounded map
(10 000 entries) keyed by `jti`, pruned at `exp` on every claim. It is
process-local; the deployment runs one Code host process. If a second replica
is ever added, replay detection must move to shared storage or the ticket
audience must pin the replica.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Never expose the listener without the reverse proxy; production warns when it is not loopback. |
| `PORT` | `8090` | Listener port, integer `1..65535`; anything else warns and falls back to the default. |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | Upstream OpenCode base URL; may carry a path, never credentials. |
| `OPENCODE_USERNAME` | `opencode` | Basic-auth username for upstream. |
| `OPENCODE_PASSWORD` | none | Basic-auth password for upstream. Required in production; never logged. |
| `CODE_HOST_ORIGIN` | `http://127.0.0.1:8090` | Public origin of this host; also the ticket audience and the CSRF `Origin` target. Required and `https:` in production. |
| `APP_ORIGIN` | `http://127.0.0.1:8787` | App origin; the only allowed `frame-ancestors` and the `postMessage` target. Required and `https:` in production. |
| `CODE_TICKET_SECRET` | ephemeral, generated | HMAC key for tickets and the derived cookie key. Required in production; a development boot warns and generates one. |
| `CODE_TICKET_TTL_SECONDS` | `60` | Configured ticket lifetime. Hard ceiling 60; development clamps with a warning, production refuses a larger value. |
| `CODE_SESSION_TTL_SECONDS` | `43200` | Code session cookie lifetime (12 h). Capped at 30 days with a warning. |
| `COOKIE_SECURE` | off | Adds `Secure` and switches the cookie to `__Host-oc_code`. Required in production unless explicitly opted out. |
| `ALLOW_INSECURE_COOKIE` | off | Explicit production opt-out from `COOKIE_SECURE=1`. |
| `TRUST_PROXY` | off | Trust `X-Forwarded-For`/`X-Real-IP` for the client label in failure logs. Leave off for a direct connection. |

Both origins are validated as bare origins: no path, query, fragment or
embedded credentials. Warnings and refusals name variables only, never values.

A production boot refuses when `CODE_TICKET_SECRET` or `OPENCODE_PASSWORD` is
missing, when either origin is missing or not `https:`, when `COOKIE_SECURE`
is off without `ALLOW_INSECURE_COOKIE=1`, or when
`CODE_TICKET_TTL_SECONDS > 60`. It warns — without refusing — when `HOST` is
not loopback (the listener is plaintext and the exchange puts the ticket in a
`Location`) and when `APP_ORIGIN` and `CODE_HOST_ORIGIN` have different
hostnames (see deployment notes).

## Header policy

| Header | Behaviour |
| --- | --- |
| `Content-Security-Policy` | Upstream's policy values are forwarded unchanged. A **second** policy `frame-ancestors <APP_ORIGIN>` is appended (two header lines on `GET`, one joined policy list on `HEAD`; see below). Two policies only narrow; replacing upstream's policy could widen it. |
| `X-Frame-Options` | Dropped; `frame-ancestors` is the control. |
| `X-Content-Type-Options` | `nosniff`, always. |
| `Referrer-Policy` | `no-referrer`, always. |
| `Cache-Control` (HTML) | `no-store`. |
| `Cache-Control` (`/api/*`) | `no-store`, except SSE (below). |
| `Cache-Control` (`/assets/*`) | Upstream's value is kept, usually `public, max-age=31536000, immutable`. |
| `Cache-Control` (SSE) | `no-cache, no-transform`. |
| `X-Accel-Buffering` (SSE) | `no`. |
| `Set-Cookie` (upstream) | Dropped. The configured `oc_code`/`__Host-oc_code` is the only cookie the browser may see. |
| `Location` (upstream) | Dropped. An upstream redirect must not become an open redirect on the Code host origin. |
| `WWW-Authenticate` (upstream) | Dropped. A wrong upstream password must not raise a native Basic dialog on the Code host origin and invite the owner to store the credential there. |
| `Access-Control-*` (upstream) | Dropped, so a future upstream CORS default cannot turn the Code host into a readable cross-origin path for the owner's session. |
| Inbound `Authorization`, `Cookie`, `Host`, `Origin` | Stripped before forwarding. The proxy injects its own Basic credential and upstream has no business seeing the embedding origin. |
| Hop-by-hop headers | `connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-*` and anything named by `Connection`, in both directions. |
| Upstream `Authorization` | Also stripped from the response, so a misbehaving upstream cannot echo the credential to the client. |

A `Content-Security-Policy` header value is a comma-separated policy list in
CSP3, so the appended `frame-ancestors` is a valid second policy whether it
arrives as a second line or joined into one. The security property — a second
policy can only narrow, never widen — holds either way. The node adapter writes
the upstream value and the appended policy as two lines on `GET`; that is a
nicety, not the mechanism. `HEAD` goes through Hono's `GET` dispatch, which
loses the symbol, so it legitimately writes one joined line
(`default-src …; …, frame-ancestors …`). Both shapes are asserted.

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
upstream fetch when the browser goes away. Backpressure is waited on only
while `write` reports it, and that wait races `close`/`error` on the response
and re-checks `destroyed`; a client that stops reading and disconnects
therefore cancels the reader and settles the handler instead of pinning it
until process exit.

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
| `GET /__auth` | ticket | Verify, claim once, set the session cookie, 302 to `next`; 401 page otherwise. |
| `GET /__health` | none | 200 `{"ok":true,"version":"…"}` from upstream `/api/info` (Basic auth, 2 s timeout), 502 `{"ok":false}` otherwise. No secret or upstream error text. |
| `GET /__sign-in` | none | The sign-in page. |
| everything else | `oc_code` | Proxy to `OPENCODE_URL`, `/api/*` included. Unsafe methods additionally need same-origin evidence (403 otherwise). |

A 401 is HTML for a navigation (`Accept: text/html` or
`Sec-Fetch-Mode: navigate`, outside `/api/*`) and
`{"error":"code_session_required"}` otherwise. The HTML page links to
`${APP_ORIGIN}/login` when standalone and, when framed, posts
`{ type: "openchat:code-state", state: "unauthenticated" }` with
`targetOrigin` set to `APP_ORIGIN` — never `"*"`.

A 403 for a cross-origin write is always the small JSON body
`{"error":"cross_origin_forbidden"}` with `no-store`, whatever the `Accept`
header; it is a security answer, not a page, and it is built before the cookie
is read.

`/__health` is unauthenticated on purpose: the app needs a cheap liveness probe
before it has a session. It reveals the upstream version only and is the only
unauthenticated route that reaches upstream.

## Deployment notes

- **The ticket is a bearer credential in a URL.** `/__auth?ticket=…` lands in
  the TLS proxy's access log. The value is single-use and valid for 60 s, but
  it is still a credential: redact the query string at the proxy or keep those
  logs at a restricted retention. The Code host itself never logs the token.
- **`/__auth` needs its own rate limit.** The BFF limits minting; a redeemer
  reaches the Code host directly, so the exchange must sit behind a per-IP
  request/failure limit in the deployment proxy (or a later host-side counter).
- **The frame needs a shared registrable domain.** `chat.example.com` framing
  `code.example.com` works because both are `example.com`. With third-party
  cookies blocked, a cross-*site* frame cannot complete the exchange, so a
  deployment on two unrelated domains needs a browser policy that accepts
  third-party cookies. The boot warns when the two hostnames differ.
- **The listener belongs behind the reverse proxy.** It speaks plaintext HTTP
  and the exchange answers with the ticket in a `Location`; production warns
  when `HOST` is not loopback.
- **The sign-in page is a recorded i18n exception.** Pages served by the Code
  host are outside the app's i18n catalogue (`apps/web/src/i18n`), so the 401
  page carries fixed English text and `lang="en"`. The app UI still follows
  `en`/`de`. Translating the host pages would need their own catalogue and the
  language in the URL; that is deliberately out of scope.

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
| `packages/code-ticket/test/ticket.test.ts` | round trip, unique `jti`, TTL ceiling at mint and at read (incl. the clock-skew boundary and a hand-rolled long `exp`), refusal, wrong secret/audience/version, expiry boundary, tampered payload and signature, malformed input, bad signed claims. |
| `apps/code-host/test/env.test.ts` | defaults and warnings, explicit values, origin and URL validation, ticket TTL clamp, `PORT` bounds, session TTL cap, non-loopback production warning, hostname-mismatch warning, every production refusal, no value in a warning. |
| `apps/code-host/test/auth.test.ts` | ticket single use, expired/tampered/wrong-audience/missing, cookie flags and both names (incl. `Secure`, no `Domain`), ticket-as-cookie and cookie-as-ticket separation, verify-before-claim ordering (forged `jti` does not burn the real ticket), open-redirect fallbacks, failure log without a token, sign-in page and both 401 shapes. |
| `apps/code-host/test/gate.test.ts` | boundary table over five paths × GET/HEAD/POST/OPTIONS with zero upstream requests, expired cookie, `/__health` as the only unauthenticated reach, JSON 401 for `/api/*` with `Accept: text/html`, CSRF rejection for every unsafe method with cross-site evidence, same-origin and absent evidence proxied, cross-site reads still proxied, rejection log without origin or cookie, one accepted cookie name per configuration, address-charset log hygiene. |
| `apps/code-host/test/node.test.ts` | the response pump settles and cancels the reader when `write()` reports backpressure and the client emits `close`, resumes after `drain` and ends, and cancels immediately on an already-destroyed response. |
| `apps/code-host/test/session.test.ts` | cookie round trip, wrong secret, expiry, tampering, attributes and both names, clear-cookie, cookie parsing. |
| `apps/code-host/test/replay.test.ts` | first-claim wins, per-`jti` independence, expiry pruning, bounded growth. |
| `apps/code-host/test/proxy.test.ts` | shell body, two CSP lines with byte-identical upstream policy, one joined CSP line on `HEAD`, no `X-Frame-Options`, dropped upstream `Location`/`WWW-Authenticate`/`Access-Control-*`, no inbound `Origin`, Basic injection, stripped cookies and echoed credential, `no-store` on `/api/*`, asset cache exception, POST body and query forwarding, 502 without detail, SSE first chunk while upstream is open. |
| `apps/code-host/test/health.test.ts` | version probe, Basic header, 401/malformed/unreachable upstream, timeout, no error text. |

## Not implemented in this slice

- No BFF endpoint mints a ticket; `packages/code-ticket` is the primitive the
  BFF slice will call.
- No UI: the Chat | Code switch, slim bar, `/code/*` deep links and the
  embedding frame are later slices.
- No rate limiting on ticket minting or the exchange in this slice. The mint
  limit now lives in the BFF (`apps/server/src/code.ts`); the `/__auth`
  exchange limit still belongs in the deployment proxy (see deployment notes).
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

Probes the Code host's `/__health` server-side and compares the major of its
version with `SUPPORTED_OPENCODE_MAJOR` from `@opencode/client` (exported by
`packages/opencode`). The dependency range is `^2.3.0`: minor and patch
releases are adopted through CI, while the major stays pinned
([12 — dependency updates](./12-dependency-updates.md)).

```json
{ "configured": true, "reachable": true, "version": "2.4.0",
  "expectedVersion": "2", "matches": true }
```

- Unconfigured: `200 {configured:false, reachable:false,
  expectedVersion, matches:false}` without any probe.
- Reachable with `{ok:true, version}`: `reachable:true`, `version` set and
  `matches: matchesSupportedMajor(version)`. A `2.4.0` host is healthy next to
  the `2.3.0` client; a `3.0.0` host warns. A mismatch warns, never blocks.
- Any failure — transport error, non-2xx, timeout, malformed body — is
  `reachable:false`, `matches:false`, `version` omitted. The response never
  contains a ticket, the secret or upstream error text.
- The result is cached in memory for 10 s (`CODE_STATUS_CACHE_MS`, injectable),
  so a polling UI cannot hammer the Code host. `Cache-Control: no-store`.

### `InfoResponse.code`

`/api/info` now carries `code: { configured, expectedVersion }`, where
`expectedVersion` is the supported major as a string (`"2"`). The UI reads it
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
| `apps/server/test/code.test.ts` | auth on both routes, unconfigured ticket/status/info, absolute URL and encoded `next`, `readTicket` claims (`sub`, `codeHost`, `exp` within TTL), `next` sanitisation table, fresh `jti` per mint, no ticket in status or logs, 21st mint `429` and window reset, same-major/minor-skew/major-skew/unreachable/malformed/timeout status, 10 s probe cache and `/api/info` reporting. |
| `apps/server/test/env.test.ts` | origin validation, development secret generation, production refusal without a secret, https requirement, TTL clamp and refusal, timeout parsing. |
| `packages/opencode/test/supported-major.test.ts` | `OPENCODE_CLIENT_RANGE` against the package manifest, `SUPPORTED_OPENCODE_MAJOR` derived from the range, the installed `@opencode/client` satisfying the range, and the major comparison for same-major, minor skew, major skew and malformed versions. |

No test calls a real network host; the probe is injected.
