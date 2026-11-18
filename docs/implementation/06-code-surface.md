# 06 — Code surface: ticket, cookie and proxy

**Status:** 2026-11-18. Implements the Code host from issue #11
(`apps/code-host`), the ticket primitive (`packages/code-ticket`) and the BFF
endpoints (`apps/server/src/code.ts`); the web half lives in
[`07-code-ui.md`](./07-code-ui.md). Spec:
[`../spec/13-code-surface.md`](../spec/13-code-surface.md), architecture:
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
   verified first: constant-time HMAC compare, expiry, a read ceiling of
   `exp ≤ now + CODE_TICKET_TTL_SECONDS + 60 s skew` (the operator's lifetime,
   at most 60 s, so a shorter host setting narrows the read too), and an exact
   `codeHost` match. Hostile input returns `null`, never throws.
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
  also makes browsers reject a cookie with a `Domain` attribute at all; the
  cookie is host-only either way, so it is never sent to the app or artifact
  origin.
- `Secure` only when `COOKIE_SECURE` is on; production refuses a boot with it
  off unless `ALLOW_INSECURE_COOKIE=1` is set explicitly.
- `SameSite=Lax` keeps the cookie on the top-level ticket redirect, including
  inside the frame. It is **not** a CSRF control: it is site-scoped, not
  origin-scoped, so a sibling origin on the same registrable domain receives
  the cookie on a cross-origin `POST`.
- The cookie signing key is `HMAC-SHA256(CODE_TICKET_SECRET,
  "openchat:code-session")`, so tickets and cookies do not share a key.

### Cross-origin writes

Reads are an allowlist: `GET`, `HEAD` and `OPTIONS` pass. Every other method —
`POST`, `PUT`, `PATCH`, `DELETE`, and anything else such as `PROPFIND`, `PURGE`
or a typo'd verb the upstream might still dispatch — needs same-origin evidence.
It is refused before the session cookie is verified when `Sec-Fetch-Site` is
present and not `same-origin`, `Origin` is present and not `CODE_HOST_ORIGIN`,
or `Referer` is present with another origin. An unsafe request with none of
them passes only when it carries no session cookie: `curl` and server-to-server
clients never send these headers, while a browser sends `Origin` on every
unsafe method. An end-of-life browser that omits `Origin` *and* ignores
`SameSite` is the exception — it carries the cookie without evidence and is
refused. The 403 is `{"error":"cross_origin_forbidden"}` with `no-store`, built
locally so no upstream byte can reach the browser; the log line carries the
client attribution only. Reads stay allowed — without CORS the browser cannot
read the response, and the embedded SPA needs them. `CODE_HOST_ORIGIN` must be
the origin the browser actually uses, scheme and port included, or legitimate
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
| `CODE_TICKET_TTL_SECONDS` | `60` | Ticket lifetime, enforced at mint by the BFF and at read by the host (`exp ≤ now + ttl + 60 s skew`). Hard ceiling 60; development clamps with a warning, production refuses a larger value. |
| `CODE_SESSION_TTL_SECONDS` | `43200` | Code session cookie lifetime (12 h). Capped at 30 days with a warning. |
| `COOKIE_SECURE` | off | Adds `Secure` and switches the cookie to `__Host-oc_code`. Required in production unless explicitly opted out. |
| `ALLOW_INSECURE_COOKIE` | off | Explicit production opt-out from `COOKIE_SECURE=1`. |
| `TRUST_PROXY` | off | Trust `X-Forwarded-For`/`X-Real-IP` for the client label in failure logs. Leave off for a direct connection. |

Both origins are validated as bare origins: no path, query, fragment or
embedded credentials. Warnings and refusals name variables only, never values.

A production boot refuses when `CODE_TICKET_SECRET` or `OPENCODE_PASSWORD` is
missing, when either origin is missing or not `https:`, when `COOKIE_SECURE`
is off without `ALLOW_INSECURE_COOKIE=1`, or when
`CODE_TICKET_TTL_SECONDS > 60`. It only warns when `HOST` is not loopback (the
plaintext listener puts the ticket in a `Location`) or when `APP_ORIGIN` and
`CODE_HOST_ORIGIN` differ in hostname (see deployment notes).

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
arrives as a second line or joined into one; a second policy can only narrow,
never widen. The node adapter writes two lines on `GET`, while `HEAD` goes
through Hono's `GET` dispatch, loses the symbol and legitimately writes one
joined line (`default-src …; …, frame-ancestors …`). Both shapes are asserted.

The `/assets/*` exception is deliberate: content-hashed filenames are
immutable, carry nothing user-specific and are the bulk of the shell boot, so a
`no-store` there would re-download the whole SPA on every load. HTML and the API
are always `no-store`; everything else keeps whatever upstream sends.

## Proxy and streaming

The proxy uses the platform `fetch` with the inbound body as a `ReadableStream`
(`duplex: "half"`) and returns the upstream body as a stream; nothing is
buffered. The node adapter pumps chunks with `response.write` and flushes
headers first, so the first SSE frame reaches the browser while upstream still
holds the connection open. Its `close` handler aborts the lifecycle signal,
cancelling the upstream fetch when the browser goes away. Backpressure is
waited on only while `write` reports it; that wait races `close`/`error` and
re-checks `destroyed`, so a client that stops reading and disconnects cancels
the reader (bounded at 2 s even if `cancel` never settles) instead of pinning
the handler until process exit.

`accept-encoding: identity` is sent upstream: a compressed body would make the
proxy re-declare the wrong `content-length`. If an upstream still encodes, the
encoding and length headers are dropped because `fetch` already decoded it.

Upstream failures return `502 {"error":"code_host_unavailable"}` with no
upstream URL, error text or credential, logged as a fixed message.

## Routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `GET /__auth` | ticket | Verify, claim once, set the session cookie, 302 to `next`; 401 page otherwise. |
| `GET /__health` | none | 200 `{"ok":true,"version":"…"}` from upstream `/api/info` (Basic auth, 2 s timeout, 4 KiB body, 64-char printable version, 5 s cache), 502 `{"ok":false}` otherwise. No secret or upstream error text. |
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
header; it is a security answer, not a page, and it is built before the session
cookie is verified. The no-evidence rule looks only at whether the configured
cookie *name* is present — it never validates or logs the value.

`/__health` is unauthenticated on purpose: the app needs a liveness probe
before it has a session. The answer is bounded so the route cannot amplify: a
5 s in-process cache (successes and failures), a 2 s upstream deadline, a 4 KiB
body read and a 64-character printable version. It reveals the upstream version
only. `/__health`, `/__sign-in` and the `/__auth` rejection log line are the
deployment's unauthenticated surface; their per-IP limit belongs to the reverse
proxy.

## Deployment notes

- **The ticket is a bearer credential in a URL.** `/__auth?ticket=…` lands in
  the TLS proxy's access log and in the browser's history, because the exchange
  is a top-level navigation. The value is single-use and valid for at most
  60 s, but it is still a credential: redact the query string at the proxy,
  keep those logs at a restricted retention, and avoid syncing that history.
  The Code host itself never logs the token.
- **`/__auth` needs its own rate limit.** The BFF limits minting; a redeemer
  reaches the Code host directly, and every rejection writes one log line.
  That and the anonymous `/__health` probe are the host's unauthenticated
  surface, so both need a per-IP request/failure limit in the proxy.
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

- **Serving OpenCode under `/code/`:** the shell's absolute `/assets` and
  `/api` paths would need rewriting and would collide with the BFF.
- **Sharing the app's session cookie:** it is not sent across hosts, and a
  registrable-domain cookie would leak to the artifact origin; the ticket keeps
  each origin separate.
- **Relying on OpenCode's Basic auth only:** the shell is unauthenticated
  upstream, so the UI would be public.
- **Putting the Basic credential in a URL or the browser:** it stays in the
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
| `packages/code-ticket/test/ticket.test.ts` | round trip, unique `jti`, TTL ceiling at mint and at read (incl. the clock-skew boundary, a receiver-configured shorter TTL and a hand-rolled long `exp`), refusal, wrong secret/audience/version, expiry boundary, tampered payload and signature, malformed input, bad signed claims. |
| `apps/code-host/test/env.test.ts` | defaults and warnings, explicit values, origin and URL validation, ticket TTL clamp, `PORT` bounds, session TTL cap, non-loopback production warning (incl. a `127.example.com` DNS name), hostname-mismatch warning, every production refusal, no value in a warning. |
| `apps/code-host/test/auth.test.ts` | ticket single use, expired/tampered/wrong-audience/missing, configured-lifetime rejection, cookie flags and both names (incl. `Secure`, no `Domain`), ticket/cookie key separation in both directions, verify-before-claim ordering (forged `jti` does not burn the real ticket), open-redirect fallbacks, failure log without a token, sign-in page and both 401 shapes. |
| `apps/code-host/test/gate.test.ts` | boundary table over five paths × GET/HEAD/POST/OPTIONS with zero upstream requests, expired cookie, `/__health` as the only unauthenticated reach, JSON 401 for `/api/*` with `Accept: text/html`, CSRF rejection for every unsafe method with cross-site evidence, the read allowlist (`PROPFIND`/`PURGE`/typo'd verbs), cookie-bearing no-evidence refusal, cookie-less allowance, origin check before the session read, same-origin and absent evidence proxied, cross-site reads still proxied, rejection log without origin or cookie, one accepted cookie name per configuration, address-charset log hygiene. |
| `apps/code-host/test/node.test.ts` | the response pump settles and cancels the reader when `write()` reports backpressure and the client emits `close`, resumes after `drain` and ends, cancels immediately on an already-destroyed response, and abandons a reader whose `cancel` never settles. |
| `apps/code-host/test/session.test.ts` | cookie round trip, wrong secret, expiry, tampering, attributes and both names, clear-cookie, cookie parsing, derived key stability and key separation from `CODE_TICKET_SECRET`. |
| `apps/code-host/test/replay.test.ts` | first-claim wins, per-`jti` independence, expiry pruning, eviction of the oldest entry at the default bound. |
| `apps/code-host/test/proxy.test.ts` | shell body, two CSP lines with byte-identical upstream policy, one joined CSP line on `HEAD`, no `X-Frame-Options`, dropped upstream `Location`/`WWW-Authenticate`/`Access-Control-*`, no inbound `Origin`, Basic injection, stripped cookies and echoed credential, `no-store` on `/api/*`, asset cache exception, POST body and query forwarding, 502 without detail, SSE first chunk while upstream is open. |
| `apps/code-host/test/health.test.ts` | version probe, Basic header, 401/malformed/unreachable upstream, timeout, 5 s cache (success and failure), truncated/printable version, bounded body, no error text. |

## Not implemented in this slice

- No UI: the Chat | Code switch, slim bar, `/code/*` deep links and the
  embedding frame are later slices.
- No host-side rate limit on the `/__auth` exchange; it belongs in the
  deployment proxy. Minting is limited in the BFF (`apps/server/src/code.ts`).
- No WebSocket upgrade tunneling (see above).
- The real-OpenCode framing check remains an operational step; the header path
  is covered by tests.

## BFF endpoints

**Status:** 2026-11-18. This section supersedes the "Not implemented" notes
about a missing mint endpoint and missing rate limiting. The UI, deep links and
the frame are still later slices. Both routes sit behind the existing `/api/*`
authentication middleware and answer `401` without a session.

### `GET /api/code/ticket?next=<path>`

Mints one single-use ticket and returns the Code host entry URL.

```json
{ "url": "https://code.example.com/__auth?ticket=…&next=%2Fworkspace%2Fx" }
```

- Unconfigured deployment (`CODE_HOST_ORIGIN` empty): `404
  {"error":"code_not_configured"}`. Nothing is minted and nothing is logged.
- Throttled per client address with `FixedWindowThrottle`: 20 mints in a fixed
  60 s window; the 21st answers `429` with `Retry-After`, like login.
- Claims: `sub` is the authenticated user, `codeHost` is `CODE_HOST_ORIGIN`,
  `exp` uses `CODE_TICKET_TTL_SECONDS` and `jti` is fresh per request.
- `Cache-Control: no-store`. The ticket is never logged, stored or echoed by
  either process; it reaches the browser's history and the proxy access log
  through `/__auth` (deployment notes).
- This is a state-consuming `GET`: a same-site sibling can burn the owner's
  20-per-minute budget with `<img src="/api/code/ticket">`, because
  `SameSite=Lax` attaches the cookie to a same-site subresource. The only
  effect is a `429` on the next real mint.

`next` is sanitised to a path on the Code host: non-empty, starts with `/`, not
`//`, no backslash and no control bytes; anything else becomes `/`. A
scheme-shaped value cannot escape: without a leading `/` it falls back, and
`/https:…` is a path on this origin. The host still re-validates it.
**Division of responsibility:** the BFF sanitises as defence in depth, the Code
host re-validates (including its percent-decoding check) and is authoritative.

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
  `matches: version === expectedVersion`. The version is capped at 64 printable
  characters before it is compared or returned. A mismatch is reported in the
  response; the non-blocking warning is client-side (07). The BFF never blocks.
- Any failure — transport error, non-2xx, redirect, timeout, malformed body,
  body over 4 KiB — is `reachable:false`, `matches:false`, `version` omitted.
  The probe sends `redirect: "error"`, so another origin cannot answer it. The
  response never contains a ticket, the secret or upstream error text.
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
| `CODE_STATUS_TIMEOUT_MS` | `2000` | `/__health` probe deadline; positive integer, clamped to `100..10000` ms. |

Warnings and refusals name the variable only, never a value.

### Tests

| File | Covers |
| --- | --- |
| `apps/server/test/pump.test.ts` | the BFF response pump settles and cancels the reader when a client disconnects during backpressure, resumes after `drain`, and abandons a reader whose `cancel` never settles. |
| `apps/server/test/code.test.ts` | auth on both routes, unconfigured ticket/status/info, absolute URL and encoded `next`, `readTicket` claims (`sub`, `codeHost`, `exp` within TTL), `next` sanitisation table (including `//` and scheme-shaped input), redirects disabled on the probe, bounded body and 64-char version, fresh `jti` per mint, no ticket in status or logs, 21st mint `429` and window reset, matching/mismatching/unreachable/malformed/timeout status, 10 s probe cache and `/api/info` reporting. |
| `apps/server/test/env.test.ts`, `env-bounds.test.ts` | origin validation, development secret generation, production refusal without a secret, https requirement, TTL clamp and refusal, `PORT` `1..65535`, status-timeout `100..10000` ms clamp, timeout parsing. |
| `packages/opencode/test/pinned-version.test.ts` | `PINNED_OPENCODE_VERSION` against the package manifest and the installed `@opencode/client`. |

No test calls a real network host; the probe is injected.

## Open doc conflicts (owner-owned)

Owner-owned docs that disagree with the code; not edited here, the code is
authoritative until the owner reconciles them.

- **Spec 13:** an unticketed Code host "redirects to the app login". It answers
  `401` with its own sign-in page (a link to `${APP_ORIGIN}/login` plus a
  `postMessage`); it never redirects.
- **Architecture 06, "no anonymous access":** `/__health` and `/__sign-in` are
  anonymous by design — bounded, read-only, and no upstream route beyond
  `/api/info`.
- **Architecture 06, ticket flow step 5:** "on expiry, the host redirects to
  the app". It answers the 401 page or JSON; the client (07) re-mints on
  request.
- **Architecture 06, rate limits:** minting is limited in the BFF (20 per
  minute per address); the exchange has no host-side counter and is deferred to
  the proxy.
