# 09 — Artifacts: storage, signing and the artifact host

**Status:** 2026-11-18. First of four slices for issue #13 (milestone v2.0).
Implements the foundation from
[`../architecture/04-artifact-sandbox.md`](../architecture/04-artifact-sandbox.md)
and the serving rules from
[`../architecture/07-artifact-runtime.md`](../architecture/07-artifact-runtime.md),
plus FR-37…FR-40 in
[`../spec/01-product-scope.md`](../spec/01-product-scope.md).

M4 (the read-only artifact viewer, issue #6) never shipped, so nothing
artifact-related existed in code before this slice. This slice ships storage,
signing, the separate-origin byte host and the BFF surface. It ships **no UI**.

## What ships

| Piece | Where | What it does |
| --- | --- | --- |
| Contracts | `packages/contracts/src/artifacts.ts` | limits, `ArtifactMeta`, `ArtifactResponse`, `ArtifactCreateRequest`, `ArtifactsSurfaceInfo`; `InfoResponse.artifacts`. |
| Store | `apps/server/src/artifacts-store.ts` | content-addressed directory per artifact, validation, dedupe, newest-first list. |
| Signing | `apps/server/src/artifacts-sign.ts` | HMAC-SHA256 over `id` and `exp`, constant-time verify, URL builder. |
| BFF routes | `apps/server/src/artifacts.ts` | `POST/GET /api/artifacts`, `GET /api/artifacts/:id`, creation throttle, `artifacts` in `/api/info`. |
| Byte host | `apps/artifact-host/` | its own origin; serves `/a/<id>?exp&sig` with the sandbox headers and `/healthz`. |
| Env | `apps/server/src/env.ts`, `apps/artifact-host/src/env.ts`, `.env.example` | see the tables below. |

The pure signer is **one module, not two copies**: the host imports
`@openchat/server/artifacts-sign` (a subpath export of the BFF package). The
module has no HTTP, store or BFF dependency, and a duplicated verifier would be
a drift bug waiting for its first key rotation. Everything else about the host
is independent. Because it is a workspace package that imports another one, the
host's image (a later slice) builds from the repository root like the other
apps, not from `apps/artifact-host` alone.

## Two-origin topology

```
browser ──session cookie──▶ BFF (chat origin)
   │                          │ POST /api/artifacts  (store, sign)
   │                          ▼
   │                     ARTIFACTS_DIR/<sha256>/index.html + meta.json
   │                          ▲ read-only mount
   │◀──iframe, no cookie──── artifact host (artifact origin)
                              GET /a/<id>?exp=…&sig=…  → bytes + CSP
```

- The chat origin owns the session cookie and the API. The artifact origin owns
  nothing: no cookie, no auth, no CORS, no redirect, no write, no network.
- Both processes share exactly two values: `ARTIFACT_SIGNING_KEY` and the
  directory (a read-only mount for the host).
- A signature is not a credential for anything else: it grants one document for
  at most 15 minutes, and the artifact frame is
  `sandbox="allow-scripts"` without `allow-same-origin`, so the document runs on
  an opaque origin.

## Signed URLs

```
GET /a/<id>?exp=<unix-seconds>&sig=<base64url HMAC-SHA256>
HMAC key   = ARTIFACT_SIGNING_KEY
message    = id + "\n" + exp
signature  = base64url(HMAC-SHA256(key, message)), no padding, 43 characters
```

- `ARTIFACT_URL_TTL_SECONDS = 900` (15 minutes). Every read — list, single get,
  create response — signs **fresh**, so a long-open page refreshes instead of
  holding a stale URL.
- The BFF mints `exp = floor(now/1000) + 900`. The host accepts
  `exp > now` and `exp <= now + 900 + 60`; the extra minute is clock skew, not a
  longer lifetime. A URL "minted for the far future" is therefore rejected even
  when its signature is valid.
- Verification order: shape (`/^[0-9a-f]{64}$/` id, digits-only `exp`, 43
  base64url characters), then `crypto.timingSafeEqual` on equal-length buffers,
  then the time window. A malformed signature never reaches a length-dependent
  compare, and an expired one is only reported as expired when it was genuinely
  signed.
- `exp` is a string from the query; `1e9`, `+1`, ` 1` and `1.5` are refused
  before conversion.
- The host validates the signature **before** it touches the filesystem, so an
  unsigned request cannot probe which ids exist, and the 403 is byte-identical
  for a bad signature, an expired URL and an unknown-shape id.
- The id is the SHA-256 of the bytes, so the `ETag` is `"sha256:<id>"` without
  rehashing the file.

## Header set on a document

| Header | Value | Why |
| --- | --- | --- |
| `Content-Type` | `text/html; charset=utf-8` | The host serves exactly one kind of file. |
| `Content-Security-Policy` | `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <ARTIFACT_FRAME_ANCESTORS>` | Default deny. `unsafe-inline` is acceptable only on the isolated origin; there is no `unsafe-eval`, no `'self'` and no remote image source (which would reopen exfiltration through `new Image().src`). `frame-ancestors` names the chat origin, the only page allowed to frame it. |
| `Content-Security-Policy` (second) | `sandbox allow-scripts` | Keeps the document sandboxed even if a future embed forgets the iframe attribute. `allow-same-origin` is deliberately absent: with `allow-scripts` it would give the artifact its origin's storage and cookies. |
| `X-Content-Type-Options` | `nosniff` | A document must never be sniffed into another type. |
| `Referrer-Policy` | `no-referrer` | The signed URL must not leak through a referer if the frame navigates. |
| `Cache-Control` | `no-store` | A signed URL is per-read; a cache would outlive it. |
| `ETag` | `"sha256:<id>"` | Identity of the bytes without a second hash. |
| `Set-Cookie` | **never** | The artifact origin hands out no credential, whatever a handler does; the node adapter drops it. |
| `Access-Control-Allow-Origin` | **absent** | No readable cross-origin path; the frame does not need one. |
| `Location` | **absent** | No redirects: a redirect would turn the host into an open redirect. |

A CSP header value is a comma-separated policy list in CSP3, so two policies are
enforced as an intersection. The node adapter writes them as two header lines;
`Headers` only exposes the joined value, which a direct app test sees. Both
shapes are asserted.

## Storage layout and dedupe

```
<ARTIFACTS_DIR>/<id>/index.html    the exact UTF-8 bytes that were posted
<ARTIFACTS_DIR>/<id>/meta.json     { title, bytes, createdAt }
```

- `id` = lowercase hex SHA-256 of the document bytes (64 characters).
  Identical documents share one directory: a second write returns the stored
  metadata and **cannot** rewrite the first title or creation time; `meta.json`
  is written only when it does not exist.
- Writes go through `index.html.tmp` / `meta.json.tmp` in the same directory and
  are renamed into place. A crash leaves a `.tmp` file at worst, never a half
  document under the real name.
- Validation before writing: `title` and `html` must be strings; `html` must not
  be blank, must be at most 1 MiB, and its trimmed, lower-cased start must be
  `<!doctype html` or `<html`. The title is trimmed, control characters become
  spaces, the result is capped at 120 code points (never mid surrogate pair) and
  falls back to `Untitled` when blank.
- `createdAt` comes from an injected clock (`now?: () => number`) so tests do not
  sleep. The store never throws on a missing directory: `get()` returns `null`
  and `list()` returns `[]`.
- `list({ limit })` is newest first by `meta.json.createdAt` (ISO 8601 UTC sorts
  lexicographically), tie-broken by id, capped at 100.
- The BFF creates the directory lazily on the first write; a host that starts
  before any artifact exists simply answers 404 for everything.

## BFF routes

All three sit behind the existing `/api/*` guards and authentication: a request
without a session is 401, and `POST` needs `Content-Type: application/json` and
same-origin evidence.

| Route | Behaviour |
| --- | --- |
| `POST /api/artifacts` | Validates, stores, answers `201 ArtifactResponse` with a fresh signed URL. `Cache-Control: no-store`. |
| `GET /api/artifacts` | `200 ArtifactResponse[]`, newest first, at most 100, every entry signed at this read. `no-store`. |
| `GET /api/artifacts/:id` | `200 ArtifactResponse` or `404 artifacts_unknown`. `no-store`. |

- **Availability.** `artifacts.available` in `/api/info` is true only when
  `ARTIFACT_HOST_URL` **and** `ARTIFACT_SIGNING_KEY` are both set. Otherwise
  `POST` and `GET /:id` answer `503 artifacts_unavailable` with the fixed message
  `Artifact storage is not configured`, `GET /api/artifacts` answers `200 []`,
  and the server boots normally. One half configured is a warning, not a boot
  failure.
- **Throttle.** `FixedWindowThrottle`, 20 accepted writes per client address per
  fixed 60 s window; the 21st answers `429 too_many_requests` with `Retry-After`.
  Only an accepted write consumes the budget: a rejected body never reaches the
  disk, so it is not an amplifier.
- **Body cap.** The generic JSON cap is 128 KiB, which is below one 1 MiB
  document. `POST /api/artifacts` therefore has its own declared-body ceiling,
  `ARTIFACT_BODY_MAX_BYTES = 2 MiB + 4 KiB` (JSON escaping can double the
  string), while the store still enforces the 1 MiB document limit. A body over
  the envelope answers `413 payload_too_large`; a document over 1 MiB answers
  `400 artifacts_invalid`.
- **Errors.** `{ error: { code, message } }`, codes `artifacts_unavailable`,
  `artifacts_unknown`, `artifacts_invalid`, `too_many_requests`. Messages are
  fixed short phrases (`html must not be empty`,
  `html must start with <!doctype html or <html>`, …); no id, title, document
  fragment or key is echoed. An unshaped id and an unknown id both answer
  `404 artifacts_unknown`.
- **Logging.** The module logs nothing. A signed URL lives in the response body
  only — signing it into a log line would put a working URL into the log file.
- The store and the signer are constructed once per app, like the ticket
  throttle; `now` is injectable for tests.

## Host routes

| Route | Behaviour |
| --- | --- |
| `GET /a/:id?exp&sig` | Signature first, bytes second. `403 artifact_forbidden` for expired/bad/unshaped; `404 artifact_not_found` for a valid signature over a missing artifact; otherwise `200` with the headers above. |
| `GET /healthz` | `200 {"status":"ok"}`, no artifact headers, no CSP, no `no-store` (the one cacheable answer is the liveness one). |
| anything else | `404 not_found`, small JSON body, no redirect. |

`ARTIFACT_FRAME_ANCESTORS` defaults to `http://localhost:5173` (the Vite dev
origin). **A deployment sets it to the chat origin**, e.g.
`https://chat.example.com`; the host refuses a value containing `;` or a control
character, because either would inject a CSP directive or a header.

The host boots with a clear error when `ARTIFACT_SIGNING_KEY` is missing or
shorter than 32 characters. It never generates one: an ephemeral key would not
match the BFF and every URL would 403. A missing `ARTIFACTS_DIR` is fine.

Same-origin policy, explicitly: no authentication, no cookie, no CORS header, no
redirect, no write, no directory listing, and no path that is not
`/a/<64 hex>` or `/healthz`.

## Environment

| Variable | Process | Default | Meaning |
| --- | --- | --- | --- |
| `ARTIFACT_HOST_URL` | BFF | unset | Public base URL of the artifact host, e.g. `http://localhost:4100`. Absolute `http(s)` URL, no credentials/query/fragment, trailing slash dropped; `https:` in production. Empty disables the surface. |
| `ARTIFACT_SIGNING_KEY` | both | unset | Shared HMAC key, at least 32 characters. Empty disables the BFF surface; the host refuses to boot without it. Never logged. |
| `ARTIFACTS_DIR` | both | BFF: `<WORKSPACE_DIR>/.openchat-artifacts`; host: `./.openchat-artifacts` | The store. The host must point at the BFF's directory and mount it read-only. |
| `ARTIFACT_FRAME_ANCESTORS` | host | `http://localhost:5173` | The chat origin allowed to frame a document. |
| `HOST` / `PORT` | host | `127.0.0.1` / `4100` | Bind address and port. The host has no credentials, so it must not be published directly; put the TLS proxy in front. |

Warnings and refusals name the variable only, never a value.

## Deliberate deviation: storage lives in the BFF, not in OpenCode

The architecture sketch
([`../architecture/02-opencode-integration.md`](../architecture/02-opencode-integration.md))
had the BFF call OpenCode's `experimental.artifacts` provider and the artifact
host fetch `view()` bytes back through the BFF. This slice stores documents in a
content-addressed directory owned by the BFF instead. Reasons:

1. **The provider API is experimental in the pinned client.** `entry`/`url`
   semantics were not verified against the pinned version, and the code path
   would depend on an opt-in flag (`experimental.artifacts: true`) that a
   deployment can forget.
2. **The sandbox needs plain files on a read-only mount with no network.** A
   host that calls back into the BFF to fetch bytes gives the artifact container
   a network path to the chat origin — the opposite of the "no network route to
   OpenCode or the workspace" rule in
   [`04-artifact-sandbox.md`](../architecture/04-artifact-sandbox.md).
3. **The tool will post to the BFF anyway.** `openchat_app_write` validates and
   compiles in its own process and needs an HTTP target; adding a provider hop
   behind the BFF only adds a second failure mode.

What does not change: the host/proxy contract — `/a/<id>?exp&sig`, the CSP
headers, the read-only mount, the egress deny. A later switch to OpenCode's
provider is a storage swap inside `ArtifactStore` plus an internal fetch in the
host; the routes, the signature scheme and the UI contract stay as they are.

Two smaller deviations follow from the same slice:

- **Body cap.** `MAX_BODY_BYTES` (128 KiB) is too small for a 1 MiB document, so
  the artifacts route gets its own declared-body ceiling. The generic cap for
  every other route is unchanged.
- **Shared signer.** The host imports the BFF's pure signing module (see above)
  rather than carrying a copy.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Host not configured | Surface hidden (`available: false`); create/read answer 503, list answers `[]`. |
| Only half configured | Same as unconfigured, plus one boot warning. |
| Signing key shorter than 32 characters | BFF and host refuse the boot; the message names the variable. |
| Store directory missing | List is `[]`, reads 404; the first write creates it. |
| Disk full / unwritable directory | The store throws, `onError` answers `500 internal_error` without detail; nothing is logged with a path. |
| Expired URL | Host answers 403; the client requests a fresh one (the UI slice will retry once). |
| Forged or truncated signature | 403 before any filesystem access. |
| Artifact deleted while a page is open | 404 on the next read; the UI shows "unavailable" for that frame. |
| Document over 1 MiB | `400 artifacts_invalid`, nothing written. |
| Missing document header | `400 artifacts_invalid` with the rule phrase. |

## Not implemented in this slice

- **No UI**: no artifact card, no iframe, no present mode, no download button,
  no reset. The UI is the next slice; it reads `ArtifactsSurfaceInfo` from
  `/api/info` and the three BFF routes.
- **No validator and no build step** (`openchat_app_write`, Preact/Bun compile,
  CSP check for `eval`/`fetch`/CDN URLs, shell assembly).
- **No `postMessage` bridge** (`artifact:init`, `artifact:ready`,
  `artifact:resize`, `artifact:result`, nonce).
- **No MCP tool** (`packages/artifact-tool`) and no compose/Dockerfile for the
  host; the deployment docs already describe the container (read-only, no
  egress, `ARTIFACT_SIGNING_KEY` only).
- **No runtime migration job.** The stored bytes are served verbatim; the
  "re-render on `get()`" migration in
  [`07-artifact-runtime.md`](../architecture/07-artifact-runtime.md) belongs to
  the tool slice, which owns the runtime version.
- **No internal bearer route** (`POST /internal/artifacts` with
  `ARTIFACT_INTERNAL_TOKEN`) from the architecture sketch: the tool does not
  exist yet, and a public-session route was the smaller surface for this slice.
  The tool slice adds the bearer route next to it, sharing the same
  `ArtifactStore`.
- **No rate limit on reads** and no per-artifact result quota: both depend on
  the UI and the bridge.
- Conditional requests (`If-None-Match`) are not answered with 304; the header
  is `no-store`, so a browser should not ask.

## Tests

| File | Covers |
| --- | --- |
| `apps/server/test/artifacts-sign.test.ts` | deterministic unpadded base64url, id/expiry/key separation, URL shape and trailing slash, TTL, expired, far-future ceiling and its boundary, tampered signature, unshaped id/exp/signature tables, hostile input without a throw, URL round trip. |
| `apps/server/test/artifacts-store.test.ts` | validation table (types, blank, size, document start), accepted document starts (doctype, uppercase, whitespace, BOM), exact byte cap, title sanitisation (trim, control characters, blank, 120 code points, emoji), layout and metadata, dedupe keeps the first title, one-byte difference, `null` for unknown/unshaped/broken, newest-first list, 100 cap and smaller limit, missing directory, no `.tmp` left behind. |
| `apps/server/test/artifacts.test.ts` | auth on all three routes, unconfigured/info/503/`[]`, half-configured, 201 metadata and a URL that verifies, on-disk bytes, dedupe, invalid-body table, non-object and malformed JSON, content-type guard, envelope 413, title capping, no URL/key in logs, 20-per-window throttle plus reset and free rejected bodies, newest-first list with freshly signed URLs, read by id, 404 for unknown and unshaped ids without echo, empty surface. |
| `apps/server/test/artifacts-env.test.ts` | defaults, explicit values, path prefix and trailing slash, half-configured warnings without values, 32-character key floor, URL validation table, production https refusal and acceptance. |
| `apps/artifact-host/test/app.test.ts` | every document header, the two CSP lines and the verbatim policy, no cookie/CORS on any route, 403 table (missing, short, padded, non-digit, expired, far future, wrong key, unshaped id), signature-before-filesystem ordering, byte-identical non-ASCII output, 404 for a valid signature over a missing id, 404 for an unknown path, `/healthz` without artifact headers, no writes into the directory, traversal rejected in the reader, node header map (array, joined fallback, dropped `Set-Cookie`), configured frame ancestors. |
| `apps/artifact-host/test/env.test.ts` | defaults, explicit values, missing/short key refusals, frame-ancestor injection refusal, port warning, no key in a warning. |

No test starts a real OpenCode, signs a URL for the network or calls an external
host. Host tests use an ephemeral loopback listener, as the Code host tests do,
because duplicate `Content-Security-Policy` lines are only observable at the
node level.
