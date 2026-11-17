# 07 — Artifact Runtime: Interactive Apps

Status: V2 design (2026-11-17). Implements FR-37 … FR-40. Decision record:
ADR-0006.

The chat can show interactive apps — calculators, charts, simulations,
dashboards — without letting model output run on the app origin and without a
network at runtime. The model writes one Preact component; the host compiles it
into a single portable HTML document, stores it as an artifact, and serves it
from the sandboxed artifact origin.

## Flow

```
model ──tool call──▶ openchat_app_write (MCP, next to OpenCode)
                         │ validate → Bun.build (JSX → h)
                         ▼
                   BFF POST /internal/artifacts  (bearer, never public)
                         ▼
                   OpenCode experimental.artifacts (static provider)
                         ▼
                   artifact-host (signed URL, CSP, egress deny)
                         ▼
                   iframe, allow-scripts only
```

Why a tool and not a chat instruction: a tool call is the only enforceable
contract. If validation fails, no artifact exists and the error returns into the
turn for repair. A prompt can be ignored, drift under compaction, or be
truncated mid-document.

## Tool contract

One MCP server ships with the repo (`openchat-artifacts`, stdio), declared in
the project `opencode.json`:

```jsonc
{
  "mcp": {
    "servers": {
      "openchat-artifacts": {
        "type": "local",
        "command": ["bun", "run", "packages/artifact-tool/src/index.ts"],
        "environment": { "OPENCHAT_BFF_URL": "{env:OPENCHAT_BFF_URL}" }
      }
    }
  }
}
```

Tool: `openchat_app_write({ title, code, css? })`

- `title` — ≤ 120 characters, plain text.
- `code` — one JSX module, ≤ 64 KiB, top-level `function App()`.
- `css` — optional, ≤ 32 KiB, inlined into one `<style>`.

Result: `{ artifactID, title, bytes, warnings? }` — never the HTML, so the model
does not re-emit its own app.

Errors are specific and actionable (`code:3:14: Unexpected token`, `cdn-url:
line 7`, `size: 71 KiB > 64 KiB`) and the tool description tells the model to fix
exactly what is reported and retry at most twice.

## Validator rules

Reject before compiling:

| Rule | Reason |
| --- | --- |
| exactly one `code` string, ≤ 64 KiB | bounds the bundle and the turn |
| no `import` / `require` / dynamic `import()` | the runtime is pre-injected; imports would need the network |
| no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` | offline guarantee |
| no `http:` / `https:` / `//` URL literal | no CDN, no remote images |
| no `eval`, `new Function`, `document.write` | keeps `unsafe-eval` out of the CSP |
| no `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` | opaque origin has no storage; reject early with a clear message |
| no `window.open`, `window.top`, `window.parent` | the sandbox blocks it; do not rely on it |
| no `</script` in code or css | shell injection |
| `App` is defined at top level | the shell renders it after mount |

Any hit fails the tool call. The sandbox and CSP remain the backstop; the
validator exists for good error messages and deterministic output.

## Build

`Bun.build` in the tool process, pinned with the repo's Bun version:

```ts
await Bun.build({
  entrypoints: [entry],
  format: "iife",
  minify: true,
  jsx: { runtime: "classic", factory: "h", fragment: "Fragment" },
})
```

- Preact, hooks (`useState`, `useEffect`, `useMemo`, `useRef`, `useCallback`,
  `useReducer`), `h`, `Fragment` and `render` are injected; the model writes no
  imports.
- Output is deterministic for identical input and toolchain. The shell carries
  `data-oc="1"` and a comment with the Bun version, so a snapshot test catches
  drift.
- No `eval`, no WASM, no worker, no external request at runtime.
- Measured reference bundle: Preact 10.29 + hooks + a small app ≈ 5.4 KiB
  gzipped; compile time ≈ 20 ms.

## Shell

The tool assembles one document and stores it as the artifact's `index.html`:

```html
<!doctype html><html lang="en" data-oc="1"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>…</title>
<style>/* reset + tokens: --bg --fg --muted --accent --radius */</style>
<style>/* validated user css */</style>
</head><body><div id="root"></div>
<script>/* bridge shim */</script>
<script>/* preact + App IIFE */</script>
</body></html>
```

- Code and CSS are JSON-embedded and `<` is escaped as `\u003c`; a raw
  `</script` must never reach the document.
- The artifact stays a single portable file: download returns exactly these
  bytes, and present mode loads the same document.
- Runtime upgrades re-render stored artifacts on `get()` in a migration job; the
  serve path never rewrites bytes (it is a read-only host).

## Runtime API

```js
window.openchat = {
  theme,        // "light" | "dark" from artifact:init
  locale,       // "en" | "de"
  onInit(fn),   // runs after artifact:init, or immediately if already fired
  result(payload), // { title?, text?, data? } → artifact:result, ≤ 64 KiB
  setHeight(px),   // optional; a ResizeObserver on #root is the default
}
```

- Height is content-driven; a fixed `100vh` is rejected by review and breaks the
  frame.
- `artifact:reset` (app → artifact) unmounts and re-renders `App` from scratch,
  so reset needs no new signed URL and state must live in hooks.
- The bridge keeps the rules from
  [`04-artifact-sandbox.md`](04-artifact-sandbox.md): messages are accepted by
  `event.source` plus nonce, never by `event.origin` (`"null"` under
  `allow-scripts`).
- The API is the only privileged surface. It exposes no token, no cookie and no
  app API.

## Serving

`apps/artifact-host` only adds headers: the CSP below with `sandbox
allow-scripts` as a second policy, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `ETag:
sha256(bytes)`.

Runtime injection happens at **write time**, never per request: the host is a
read-only byte server with no network, the preview must equal the download, and
per-request compilation would make both differ.

## CSP change

`script-src 'unsafe-inline'` only; drop `'unsafe-eval'` (ADR-0006). The runtime
and the generated bundle need no eval, and removing it narrows what an escaping
bug could do. Keep `default-src 'none'`, `connect-src 'none'`, no `'self'`.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Validation error | tool call fails with line/column; model repairs once or twice |
| Second failure | answer degrades to a short explanation, no artifact |
| Build error | same as validation, with the compiler message |
| App throws at runtime | the frame shows a short error panel; the chat is unaffected |
| App needs a worker or storage | unsupported; the prompt says so and the app must degrade |
| Runtime version skew | migration re-renders stored artifacts on `get()` |

## Risks

- **Remote OpenCode host.** The MCP tool runs next to OpenCode, so a loopback
  BFF URL fails when OpenCode is remote. Use `OPENCHAT_BFF_URL` from config, and
  allow a degraded mode that writes the source into the workspace where the BFF
  can pick it up.
- **Escaping.** One bug turns model text into executable script. Single code
  path, fuzz tests, `\u003c` escaping.
- **Toolchain drift.** Determinism depends on the pinned Bun version; assert it
  in the snapshot test.
- **Model skips the tool.** Detect fenced HTML with remote references in chat
  output and offer a one-click "open as app", which runs the same validator.
- **Preact ceiling.** No workers, storage or devtools; enough for FR-37, and
  documented in the app prompt.

## Tests

Zero-quota, per [`05-testing.md`](05-testing.md):

- Validator table: CDN URL, `fetch`, `eval`, `localStorage`, `</script`,
  oversized input, syntax error with position.
- Shell snapshot: deterministic bytes, `data-oc` version, escaping.
- Fixtures: `calculator`, `chart`, `broken`, `cdn` — inputs to the tool, no
  model call.
- Stub artifact host with the real CSP: render, input → recompute, result →
  draft, wrong nonce dropped, `fetch` fails, `document.cookie` empty,
  `window.open` null, height grows, reset restores, download is byte-identical.
