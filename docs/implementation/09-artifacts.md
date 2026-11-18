# 09 — Artifacts: storage, signing and the artifact host

**Status:** 2026-11-18. First three of four slices for issue #13 (milestone v2.0).
Implements the foundation from
[`../architecture/04-artifact-sandbox.md`](../architecture/04-artifact-sandbox.md)
and the serving rules from
[`../architecture/07-artifact-runtime.md`](../architecture/07-artifact-runtime.md),
plus FR-37…FR-40 in
[`../spec/01-product-scope.md`](../spec/01-product-scope.md).

M4 (the read-only artifact viewer, issue #6) never shipped, so nothing
artifact-related existed in code before the first slice. Slice 1 shipped
storage, signing, the separate-origin byte host and the BFF surface, with no
UI. Slice 2 added the `/artifacts` surface and the viewer; its contract is in
[its own section](#slice-2--the-read-only-viewer) at the end of this document.

**Slice 3** (the third slice of the same issue) adds the write path: the
MCP tool, the validator, the compiler, the HTML shell and the
bearer-authenticated internal route. Slice 3 is documented in
[its own section](#slice-3-the-write-path); the sections before it describe
slice 1.

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

The three slice-1 routes sit behind the existing `/api/*` guards and
authentication: a request without a session is 401, and `POST` needs
`Content-Type: application/json` and same-origin evidence. The slice-2 download
route sits behind the same guards.

| Route | Behaviour |
| --- | --- |
| `POST /api/artifacts` | Validates, stores, answers `201 ArtifactResponse` with a fresh signed URL. `Cache-Control: no-store`. |
| `GET /api/artifacts` | `200 ArtifactResponse[]`, newest first, at most 100, every entry signed at this read. `no-store`. |
| `GET /api/artifacts/:id` | `200 ArtifactResponse` or `404 artifacts_unknown`. `no-store`. |
| `GET /api/artifacts/:id/download` | `200` with the stored bytes verbatim (slice 2). `Content-Disposition: attachment`, `nosniff`, `no-store`; `404 artifacts_unknown`, `503 artifacts_unavailable`. |

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

## Slice 3: the write path

**Status:** 2026-11-18. Third slice for issue #13. It adds the MCP tool, the
validator, the compiler, the document shell and the internal bearer route.
Built to
[`../architecture/07-artifact-runtime.md`](../architecture/07-artifact-runtime.md),
with one owner-visible deviation (esbuild instead of `Bun.build`, below).

### What ships

| Piece | Where | What it does |
| --- | --- | --- |
| Tool package | `packages/artifact-tool/` | stdio MCP server `openchat-artifacts` exposing `openchat_app_write`; own `package.json`, `tsconfig.json` and tests. |
| Validator | `packages/artifact-tool/src/validate.ts` | Pure rule table over `title`/`code`/`css`; no I/O, no compiler dependency. |
| Compiler | `packages/artifact-tool/src/compile.ts` | Syntax pass, then one esbuild IIFE bundling Preact plus the app; output stays in memory. |
| Shell | `packages/artifact-tool/src/shell.ts` | The document from the architecture: meta, tokens, user CSS, `#root`, inline bundle, `data-oc="1"`. |
| BFF client | `packages/artifact-tool/src/bff.ts` | One redirect-free POST to the internal route, fixed status mapping, no upstream text. |
| MCP surface | `packages/artifact-tool/src/mcp.ts` | Newline-delimited JSON-RPC on stdio: `initialize`, `ping`, `tools/list`, `tools/call`. |
| Internal route | `apps/server/src/artifacts-internal.ts` | `POST /internal/artifacts`: bearer token, 20/min, store write, `{ artifactID, title, bytes }`. |
| Env | `apps/server/src/env-artifacts.ts`, `apps/server/src/env.ts`, `.env.example` | `ARTIFACT_INTERNAL_TOKEN`, shared by the BFF and the tool. |

The tool holds no credentials for OpenCode, the workspace or the app API. Its
only privilege is the internal bearer token, and that token grants exactly one
write route.

### Tool contract

`openchat_app_write({ title, code, css? })`

| Field | Rule |
| --- | --- |
| `title` | Plain text, 1–120 code points after trimming. |
| `code` | One JSX module, at most 64 KiB, top-level `App` declaration. |
| `css` | Optional, at most 32 KiB, inlined into one `<style>`. |

Result: `{ artifactID, title, bytes, warnings? }`. Never the HTML and never a
signed URL, so the model cannot re-emit its own document or hand a link to
nobody. `warnings` appears only when the compiler produced a non-blocking
message.

The tool description carries the retry budget: fix exactly what the message
names, retry at most twice, then explain the app in text. Every rejection is one
line with a position or a fixed phrase, never a stack trace:

```
code:3:14: Unexpected token
cdn-url: line 7
size: 71 KiB > 64 KiB
app: no top-level function App found
```

Validation stops before the network: a rejected input never reaches the BFF and
never consumes the write budget.

### Validator rules

The table is the documented one
([`07:64-79`](../architecture/07-artifact-runtime.md)); every hit fails the call
with `<construct>: line N`.

| Rule | Label | Example |
| --- | --- | --- |
| no `import` / dynamic `import()` / `require` | `import`, `dynamic-import`, `require` | `import { useState } from "preact"` |
| no network | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` | `await fetch("/x")` |
| no URL literal | `cdn-url` | `"https://cdn.example/x.js"`, `"//cdn.example/x.js"` |
| no code generation | `eval`, `new Function`, `document.write` | `eval("1")` |
| no storage | `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` | `document.cookie` |
| no frame escape | `window.open`, `window.top`, `window.parent` | `window.parent.postMessage(…)` |
| no shell injection | `shell-injection` | `"</script>"` in code, `"</style>"` in CSS |
| `App` at top level | `app` | `const App = () => <div/>` (accepted) |

Two precision notes:

- **`//` is a comment, not a URL.** Only a quoted protocol-relative form
  (`"//host/…"`, `'//host/…'`, `` `//host/…` ``) counts as `cdn-url`; flagging
  every `//` would reject every comment and teach the model nothing.
- **CSS gets `</style`, code gets `</script`.** The architecture lists only
  `</script` for both inputs. A stylesheet is inlined into `<style>`, so
  `</style>` is the same escape and gets the same `shell-injection` label. The
  compiler checks the emitted script for `</script` a second time.
- A hit inside a comment or a string still counts. A rule with exceptions is a
  bypass.

### Compiler: esbuild instead of `Bun.build`

The architecture pins `Bun.build` with the repo's Bun version. This repository
is Node/pnpm and has no Bun runtime, so the same step runs on **esbuild**
(`packages/artifact-tool`, pinned by the lockfile at `0.28.2`). Reasons, in the
order that decided it:

1. **No Bun in the toolchain.** Adding a Bun binary to CI, the dev loop and the
   deploy image for one build call is a second package manager with no other
   user. esbuild is already a repository dependency (Vite/Vitest) and is
   allow-listed for its install script.
2. **Same contract.** `bundle: true, write: false, format: "iife"` plus classic
   JSX (`jsxFactory: "h"`, `jsxFragment: "Fragment"`) produces exactly the shape
   the architecture asks for: one self-contained script with Preact and hooks
   inlined, no imports left, no `eval`.
3. **Same determinism.** esbuild is deterministic for identical input and a
   pinned version. The tool builds twice in its test suite and compares bytes;
   the shell carries the toolchain versions in a comment.

Two consequences:

- **No minification.** The architecture's Bun snippet passes `minify: true`;
  here the output is unminified so the downloaded document stays inspectable.
  A reference app (Preact 10.29.8 + hooks + a counter) compiles to about
  20 KiB raw, 7 KiB gzipped, inside a 21 KiB document — far below the 1 MiB
  document cap.
- **`preact` is a dependency of the tool**, resolved from the tool package's own
  `node_modules` through `resolveDir`. The artifact never fetches a runtime.

Syntax errors are collected on the module **before** the runtime is appended.
Otherwise an unclosed JSX tag swallows the appended code and the compiler
reports a line the model never wrote; the two-pass order keeps `code:3:14` on
line 3 of the app.

### Shell

The tool assembles the documented document and posts it as the artifact's
`index.html`:

| Part | Content |
| --- | --- |
| `<html lang="en" data-oc="1">` | Runtime generation marker; a test asserts it. |
| `<meta charset>`, viewport, `color-scheme` | The three meta tags from the design. |
| `<title>` | The validated title, HTML-escaped. |
| `<style>` (first) | Reset plus `--bg`, `--fg`, `--muted`, `--accent`, `--radius` and a `prefers-color-scheme` pair. |
| `<style>` (second) | The validated user CSS. |
| `<div id="root">` | The only mount point; the bundle throws a named error if it is absent. |
| `<script>` | The Preact + app IIFE, ending in `render(h(App), root)`. |
| Comment | `openchat artifact shell 1; esbuild <version>; preact <version>` — toolchain drift shows up in a diff. |

- **The runtime is injected at write time**, never per request, so the preview,
  the download and a re-render of stored bytes are the same document.
- **No bridge yet.** `bridgeScript()` is the single placeholder slice 4 fills;
  it returns `""` today, the shell then emits no bridge `<script>` at all, and a
  test asserts that `window.openchat` is absent and that the document has
  exactly one script element.
- **CSP is unchanged.** The document carries no meta policy; the host headers
  from slice 1 are the enforced policy (`script-src 'unsafe-inline'`,
  `connect-src 'none'`, no `'unsafe-eval'`). The bundle needs no eval and no
  network, and a test compiles a sample and asserts no URL literal survives.

### Internal route

```
POST /internal/artifacts
Authorization: Bearer <ARTIFACT_INTERNAL_TOKEN>
Content-Type: application/json

{ "title": "…", "html": "<!doctype html>…" }   → 201 { artifactID, title, bytes }
```

- **Outside `/api/*` on purpose.** The caller is a process next to OpenCode, not
  a browser session: no cookie, no CSRF guard, no session middleware. The bearer
  token is the whole authentication, compared with SHA-256 plus
  `timingSafeEqual`, scheme case-insensitive.
- **The token is shared by both processes.** The BFF reads it from
  `ARTIFACT_INTERNAL_TOKEN`; the tool reads the same variable from its MCP
  environment. Two independently generated values mean every write answers 401;
  the tool's message says so without printing either value.
- **Same store, same validation.** The route constructs an `ArtifactStore` on
  the same `ARTIFACTS_DIR` and calls `create()` exactly as `POST /api/artifacts`
  does, so dedupe, title sanitisation, the 1 MiB document cap and the
  content-addressed layout cannot drift between the two writers.
- **20 accepted writes per minute per client address**, the published creation
  budget and its own bucket. Authentication runs before the budget: a wrong
  token can neither write nor exhaust the tool's writes. Only an accepted write
  consumes a slot.
- **Errors keep the shipped vocabulary**: `401 unauthorized`,
  `415 unsupported_media_type`, `413 payload_too_large`,
  `400 artifacts_invalid`, `429 too_many_requests` (with `Retry-After`),
  `503 artifacts_unavailable`. Messages are fixed phrases; no id, title or
  document fragment is echoed.
- **No signed URL in the answer.** The tool has no reader and no iframe; it
  returns the receipt, and the UI mints URLs through the public read routes.
- **Body cap.** The internal route reuses `ARTIFACT_BODY_MAX_BYTES`
  (2 MiB + 4 KiB) and the node adapter applies that cap to the path instead of
  the generic 128 KiB JSON cap.

### Environment additions

| Variable | Process | Default | Meaning |
| --- | --- | --- | --- |
| `ARTIFACT_INTERNAL_TOKEN` | BFF **and** tool | BFF: generated per development boot; unset in production is a boot failure once artifacts are configured | Bearer token for `POST /internal/artifacts`, at least 32 characters. Same value on both sides. Never logged. |

- With the artifact surface off, the token is not required and stays empty.
- With the surface configured and `NODE_ENV=production` and no token, the BFF
  refuses to boot; the message names the variable only.
- A development boot without the variable generates an ephemeral token and
  warns. The tool process cannot know that value, so a local tool run sets the
  same token on both sides explicitly.
- The tool reads `OPENCHAT_BFF_URL` (default `http://127.0.0.1:8787`) and
  `ARTIFACT_INTERNAL_TOKEN`; a missing token is a startup failure, because every
  write would answer 401 otherwise.

### Owner step: the MCP entry

`opencode.json` is owner-owned; this slice does not edit it. Add this server
(merge into the existing `mcp.servers` object), then restart OpenCode:

```jsonc
{
  "mcp": {
    "servers": {
      "openchat-artifacts": {
        "type": "local",
        "command": ["pnpm", "--filter", "@openchat/artifact-tool", "run", "start"],
        "environment": {
          "OPENCHAT_BFF_URL": "{env:OPENCHAT_BFF_URL}",
          "ARTIFACT_INTERNAL_TOKEN": "{env:ARTIFACT_INTERNAL_TOKEN}"
        },
        "enabled": true
      }
    }
  }
}
```

Before it works:

1. `pnpm install` in the repository (adds `esbuild` and `preact` to the tool
   package; esbuild's install script is already allow-listed in
   `pnpm-workspace.yaml`).
2. Export `ARTIFACT_INTERNAL_TOKEN` (at least 32 characters) for the BFF **and**
   for OpenCode's environment, plus `OPENCHAT_BFF_URL` when the BFF is not on
   `http://127.0.0.1:8787`. A remote OpenCode host needs a reachable BFF URL;
   loopback does not cross machines.
3. Keep the BFF's `ARTIFACT_HOST_URL` and `ARTIFACT_SIGNING_KEY` set, otherwise
   the tool gets `503 artifacts_unavailable`.

`/api/info` still reports only `artifacts.available`; the MCP server is not
advertised there, because the tool surface is the MCP entry above. The
architecture sketch's `bun run` command becomes the pnpm script; everything
else (stdio, `type: "local"`, environment passthrough) is unchanged.

### Fake path

A fake backend run cannot invoke an out-of-process MCP tool: the fake backend is
in-process and has no tool transport, so there is nothing to execute. This slice
does **not** invent a fake tool execution. Coverage instead:

- the tool is unit-tested against a stubbed BFF (`fetch` injection, no socket);
- the internal route is tested directly with and without the bearer token;
- the join is proven by a manual smoke (tool → route → store → list), not by a
  test, because a test would need a listening server.

The chat UI therefore shows no artifact from a fake turn. Slice 4's UI slice
owns the display path; a fake artifact card can be added there without pretending
a tool ran.

### Tests

| File | Covers |
| --- | --- |
| `packages/artifact-tool/test/validate.test.ts` | every construct in the table (import, dynamic import, require, five network APIs, three URL forms, eval/new Function/document.write, four storage forms, three window forms, `</script`), CSS `@import`/URL/`</style`, missing `App`, input shape, title cap (code points, emoji), 64 KiB and 32 KiB caps at the exact byte, UTF-8 byte counting, first-hit line, the `//` comment exception, data URIs accepted. |
| `packages/artifact-tool/test/compile.test.ts` | self-contained IIFE, mount into `#root`, no import statement, no `</script`, deterministic bytes, all documented hooks compile, syntax error with `code:line:column` inside the module, toolchain versions, shell structure, title escaping, no bridge/`window.openchat` today. |
| `packages/artifact-tool/test/tool.test.ts` | receipt only, URL/bearer/redirect-free envelope, compiled HTML in the body, validator stops before the network, status table (400/401/403/413/415/429/503/500/418) without upstream text, redirect refused, unreachable BFF, malformed receipts. |
| `packages/artifact-tool/test/mcp.test.ts` | initialize version negotiation and fallback, ping, tool listing and schema, argument passthrough, `isError`, unknown tool/method, notification silence, throwing handler, stdio framing and parse-error recovery. |
| `packages/artifact-tool/test/env.test.ts` | default BFF URL, trailing slash, path prefix, missing token refusal, URL validation table, no token in a refusal. |
| `apps/server/test/artifacts-internal.test.ts` | bearer table (missing, wrong, longer, shorter, Basic, empty, trailing junk, generated token), 503 unconfigured, 415, 413 envelope, non-object/malformed body, invalid document without echo, stored bytes on disk, receipt without URL, dedupe, `GET /api/artifacts` lists the write with a signed URL, 20/min throttle, rejected bodies and failed auth free of charge, `no-store`. |
| `apps/server/test/artifacts-env.test.ts` | token empty when off, kept when set, 32-character floor, ephemeral generation with a value-free warning, per-boot difference, production refusal when configured, production acceptance, no production requirement while off. |

No test opens a socket, starts OpenCode or signs a URL for the network; esbuild
runs in-process and writes nothing.

### Not implemented in slice 3

- **The `window.openchat` bridge** (`artifact:init`, nonce, `artifact:resize`,
  `artifact:result`). `bridgeScript()` is the hook slice 4 fills.
- **The read UI's bridge-dependent action** (in-frame reset without a new URL).
  The artifact card, iframe, present mode and download shipped in slice 2; the
  bridge path is slice 4.
- **The runtime migration job** that re-renders stored artifacts on `get()`.
- **A fake tool execution.** See the fake-path note above.
- **A Dockerfile/compose entry for the tool.** It runs next to OpenCode, not in
  the artifact host's containment.

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
| Expired URL | Host answers 403; the viewer re-reads the metadata once and then shows its recoverable stale panel (see slice 2). |
| Forged or truncated signature | 403 before any filesystem access. |
| Artifact deleted while a page is open | 404 on the next read; the UI shows "unavailable" for that frame. |
| Document over 1 MiB | `400 artifacts_invalid`, nothing written. |
| Missing document header | `400 artifacts_invalid` with the rule phrase. |

## Not implemented in slice 1

Slices 1, 2 and 3 have shipped: storage, signing, the host, the read-only
viewer and the write path. What remains is the bridge — the UI is slice 2, the
bridge is slice 4 — plus the packaging and runtime gaps listed here.

- **No `postMessage` bridge** (`artifact:init`, `artifact:ready`,
  `artifact:resize`, `artifact:result`, nonce). Slice 3 leaves the
  `bridgeScript()` placeholder empty.
- **No compose/Dockerfile for the tool or the host**; the deployment docs
  already describe the host container (read-only, no egress,
  `ARTIFACT_SIGNING_KEY` only).
- **No runtime migration job.** The stored bytes are served verbatim; the
  "re-render on `get()`" migration in
  [`07-artifact-runtime.md`](../architecture/07-artifact-runtime.md) belongs to
  a later slice, which owns the runtime version.
- **No rate limit on reads** and no per-artifact result quota: both depend on
  the bridge.
- Conditional requests (`If-None-Match`) are not answered with 304; the header
  is `no-store`, so a browser should not ask.

## Tests

| File | Covers |
| --- | --- |
| `apps/server/test/artifacts-sign.test.ts` | deterministic unpadded base64url, id/expiry/key separation, URL shape and trailing slash, TTL, expired, far-future ceiling and its boundary, tampered signature, unshaped id/exp/signature tables, hostile input without a throw, URL round trip. |
| `apps/server/test/artifacts-store.test.ts` | validation table (types, blank, size, document start), accepted document starts (doctype, uppercase, whitespace, BOM), exact byte cap, title sanitisation (trim, control characters, blank, 120 code points, emoji), layout and metadata, dedupe keeps the first title, one-byte difference, `null` for unknown/unshaped/broken, newest-first list, 100 cap and smaller limit, missing directory, no `.tmp` left behind. |
| `apps/server/test/artifacts.test.ts` | auth on every route (including download), unconfigured/info/503/`[]`, half-configured, 201 metadata and a URL that verifies, on-disk bytes, dedupe, invalid-body table, non-object and malformed JSON, content-type guard, envelope 413, title capping, no URL/key in logs, 20-per-window throttle plus reset and free rejected bodies, newest-first list with freshly signed URLs, read by id, 404 for unknown and unshaped ids without echo, empty surface. |
| `apps/server/test/artifacts-env.test.ts` | defaults, explicit values, path prefix and trailing slash, half-configured warnings without values, 32-character key floor, URL validation table, production https refusal and acceptance. |
| `apps/artifact-host/test/app.test.ts` | every document header, the two CSP lines and the verbatim policy, no cookie/CORS on any route, 403 table (missing, short, padded, non-digit, expired, far future, wrong key, unshaped id), signature-before-filesystem ordering, byte-identical non-ASCII output, 404 for a valid signature over a missing id, 404 for an unknown path, `/healthz` without artifact headers, no writes into the directory, traversal rejected in the reader, node header map (array, joined fallback, dropped `Set-Cookie`), configured frame ancestors. |
| `apps/artifact-host/test/env.test.ts` | defaults, explicit values, missing/short key refusals, frame-ancestor injection refusal, port warning, no key in a warning. |
| `apps/web/test/artifacts-page.test.tsx` | list metadata and links, loading, empty explanation, failed read with retry, redirect and no list read when unconfigured, rendering when available. |
| `apps/web/test/artifact-viewer.test.tsx` | signed URL verbatim, sandbox and title, loading, deleted artifact, failed read with retry, pre-expiry re-mint, one recovery read then a recoverable stale panel, reload, present mode plus Escape focus return, download bytes and filename, failed download, hostile titles, refresh margin. |
| `apps/web/test/app-shell.test.tsx` | the sidebar artifacts entry appears only when `artifacts.available` is true. |
| `apps/web/test/api-client.test.ts` | list, single read, same-origin download and structured download errors. |
| `apps/web/e2e/artifacts.spec.ts` | one seeded document through the real artifact host: list, frame attributes, rendered content, byte-identical download, present/Escape focus return, reload with a fresh signed URL. |

No test starts a real OpenCode, signs a URL for the network or calls an external
host. Host tests use an ephemeral loopback listener, as the Code host tests do,
because duplicate `Content-Security-Policy` lines are only observable at the
node level. The slice-3 test files are listed in the table above; they follow the
same rule, and esbuild runs in-process without writing to the workspace.

## Slice 2 — the read-only viewer

**Status:** 2026-11-18. Adds the `/artifacts` surface and the viewer, still
read-only. It consumes the slice-1 contract above; no second storage, signing or
host path is introduced.

### What ships

| Piece | Where | What it does |
| --- | --- | --- |
| Surface state | `apps/web/src/code/SurfaceProvider.tsx` | `artifactsAvailable` from `InfoResponse.artifacts.available`; `null` until `/api/info` answers. |
| Entry | `apps/web/src/chat/SessionSidebar.tsx` | `/artifacts` link, rendered only when the surface is available. Hidden and inert otherwise; the app-bar menu is unchanged. |
| Routes | `apps/web/src/App.tsx` | `/artifacts` and `/artifacts/:id`; both redirect home when the surface is unavailable, exactly like `/apps`. |
| List | `apps/web/src/artifacts/ArtifactsPage.tsx` | `GET /api/artifacts`, newest first, title plus size and write time. |
| Viewer | `apps/web/src/artifacts/ArtifactViewer.tsx` | `GET /api/artifacts/:id` on mount and reload; one iframe; present mode; download. |
| Download route | `apps/server/src/artifacts.ts` | `GET /api/artifacts/:id/download`, the exact stored bytes through the app origin. |
| Store read | `apps/server/src/artifacts-store.ts` | `read(id)` returns the bytes only when the metadata is readable too. |
| Names/formatting | `apps/web/src/artifacts/files.ts` | download filename, byte/date formatting, refresh margin. |
| i18n | `apps/web/src/i18n/messages/{en,de}.ts` | every viewer string in both locales. |
| E2E fixture | `apps/web/e2e/artifact-fixture.ts`, `playwright.config.ts` | one content-addressed document seeded before the BFF and the real artifact host start. |

The frame is exactly the documented embed:

```html
<iframe
  src="<url from GET /api/artifacts/:id>"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  loading="lazy"
  title="<artifact title>"
></iframe>
```

The URL is used verbatim. The client never derives, joins or re-signs an
artifact URL; reload and recovery re-read the metadata, and every read mints a
fresh signature.

### States

| State | Trigger | What the surface shows |
| --- | --- | --- |
| List loading | first `GET /api/artifacts` in flight | spinner and "Loading artifacts…" |
| Empty | list answered `[]` | "No artifacts yet" and that an artifact appears once the agent writes one with the app tool |
| List error | list rejected | localised error banner and Retry; the retry reads again |
| Unconfigured | `InfoResponse.artifacts.available` is false | no sidebar entry, both routes redirect to chat, and the list is never read |
| Viewer loading | `GET /api/artifacts/:id` in flight | spinner and "Loading artifact…" |
| Missing | `404 artifacts_unknown` | "Artifact not available" with the list link |
| Viewer error | any other failed read | localised error, Retry and the list link |
| Stale URL | frame `error`, or no `load` within 10 s | one metadata re-read and a fresh URL; a second failure shows "This artifact link has expired" with Reload |
| Download failure | download route rejected | error banner; the frame stays |
| Refresh failure | pre-expiry re-read rejected | error banner; the last working URL stays until it expires |
| Present | Present button | the artifact fills the content area, page chrome hides, Escape leaves and returns focus to the trigger |

**Freshness.** `GET /api/artifacts/:id` mints a URL for 15 minutes. A URL that
arrives within one minute of expiry is replaced by a second read before the
frame mounts, and an open viewer re-reads shortly before expiry. Both use the
same BFF route; neither constructs a URL.

**Why a frame failure is the stale signal.** With `sandbox="allow-scripts"` and
no `allow-same-origin`, the parent cannot read the frame's HTTP status: an
expired or refused URL is not an observable 403 on this side. The viewer treats
the two signals it does get — an `error` event and a missing `load` within 10 s —
as a refused URL, re-reads the metadata exactly once and then shows the
recoverable panel. The pre-expiry re-read keeps the 403 path rare. An explicit
host-to-app refusal message belongs to the bridge slice, which owns the nonce
and message schema.

### Download

`GET /api/artifacts/:id/download` answers the stored document verbatim with
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and
`no-store`. It sits behind the same session and `artifacts.available` check as
the other routes. The client fetches that route, never the signed host URL, so
no short-lived URL reaches the download history or a referer, and the saved
file contains only the stored bytes. The server's fallback filename is
`artifact-<id>.html`; the client saves under the artifact's title with one
`.html`, with path separators and control characters flattened.

### Deliberately not in this slice

- **No "open in new tab".** The documents do not describe one: an artifact
  opens in the app's frame, the spec's viewer chrome is title/reset/present/
  download/close, and external navigation is an explicit owner action. A new tab
  would also put a short-lived signed URL into tab state and history and could
  outlive its TTL.
- **No bridge and no `artifact:reset`.** Reset as "reload with a fresh URL" is
  what the Reload button does. The in-frame reset without a new URL needs
  `artifact:reset` over the `postMessage` bridge; that belongs to slice 3/4.
- **No inline chat card, right rail or version history.** The surface is the
  dedicated `/artifacts` route. Embedding an artifact in a message and the
  right-rail/sheet placement are integration work that needs the message
  renderer and the bridge.
- **No artifact creation UI, no validator, no MCP tool.** Those are later
  slices; this one only reads what the store already holds.
- **No screenshot harness entry.** The functional E2E covers the rendered
  surface; the screenshot seeds would need artifact-store seeding in a second
  harness, which is not part of this slice.

### Slice 2 tests

| File | Pins |
| --- | --- |
| `apps/server/test/artifacts.test.ts` | auth and exact bytes on the download route, `nosniff`/attachment/no-store headers, no signed URL or id in the body, 404 table without echo, 503 when unconfigured. |
| `apps/server/test/artifacts-store.test.ts` | `read()` returns the exact bytes and `null` for unknown, unshaped and metadata-less entries. |
| `apps/web/test/artifacts-page.test.tsx` | metadata and links, loading, empty, failed read with retry, redirect with no list read when unconfigured, list when available. |
| `apps/web/test/artifact-viewer.test.tsx` | signed URL verbatim, sandbox/title/referrer, loading, missing, retry, pre-expiry re-mint, one recovery read then the stale panel, reload re-mint, present/Escape focus return, download bytes and filename, failed download, hostile titles, freshness margin. |
| `apps/web/test/app-shell.test.tsx` | the sidebar entry is present only with `artifacts.available`. |
| `apps/web/test/api-client.test.ts` | list, single read, download path and structured download error. |
| `apps/web/e2e/artifacts.spec.ts` | seeded document through the real host: list, frame attributes and rendered document, byte-identical download, present/Escape focus return, reload with a new signature. The E2E config seeds the store and starts `apps/artifact-host` with the same key; no external host is contacted. |
