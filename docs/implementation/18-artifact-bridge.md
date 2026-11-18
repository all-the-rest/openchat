# 18 — Artifact bridge: `window.openchat`, the viewer handshake and the egress proofs

**Status:** 2026-11-18. Slice 4 of 4 for issue #13 (milestone v2.0). Consumes
the serving contract from [`09-artifacts.md`](09-artifacts.md), the runtime API
from [`../architecture/07-artifact-runtime.md`](../architecture/07-artifact-runtime.md)
and the bridge rules from
[`../architecture/04-artifact-sandbox.md`](../architecture/04-artifact-sandbox.md).

Slice 1 shipped storage, signing and the byte host. Slice 2 shipped the viewer.
Slice 3 shipped the validator, the Preact shell and `openchat_app_write`. This
slice connects the two ends of the sandbox: a validated `postMessage` protocol,
the artifact-side `window.openchat` shim, fixtures, and the two proofs the
sandbox section demands (no top navigation, no egress).

## What ships

| Piece | Where | What it does |
| --- | --- | --- |
| Viewer bridge | `apps/web/src/artifacts/bridge.ts` | `useArtifactBridge`: nonce, init handshake, source check, resize clamp, result shape/size/rate, reset. |
| Viewer wiring | `apps/web/src/artifacts/ArtifactViewer.tsx` | Sends `artifact:init` on `load`, applies the reported height, resets in place, holds the last result locally and forwards it to `onArtifactResult`. |
| Draft panel | `apps/web/src/artifacts/DraftPanel.tsx` | The editable draft under the frame: title, text, optional JSON `data`, Copy and Dismiss. |
| Frame | `apps/web/src/artifacts/parts.tsx` | Optional content height; the sandbox attribute is unchanged. |
| Artifact shim | `apps/artifact-host/src/bridge.ts` | `BRIDGE_SCRIPT`, the inlined `window.openchat` implementation. |
| Export | `apps/artifact-host/package.json` | `@openchat/artifact-host/bridge` for the tool shell (slice 3). |
| Fixtures | `apps/artifact-host/test/fixtures/` | `calculator`, `chart`, `broken` (JSX input) and `cdn` (final HTML). |
| Tests | `apps/web/test/artifact-bridge.test.tsx`, `apps/artifact-host/test/bridge.test.ts` | The protocol, the proofs and the fixtures. |

## Message table

All messages are plain objects. Every artifact → app message carries the nonce
the app sent; an app → artifact command is acted on only when the nonce matches
the one the shim stored.

| Direction | Type | Payload | When |
| --- | --- | --- | --- |
| app → artifact | `artifact:init` | `{ id, nonce, theme, locale }` | On the iframe's `load`, and up to twice more at 1 s intervals while no `ready` arrives. Every repost carries the **same** nonce. |
| artifact → app | `artifact:ready` | `{ nonce }` | Once the shim accepted `init`; stops the repost timer. |
| artifact → app | `artifact:resize` | `{ height, nonce }` | From the `ResizeObserver` on `#root`, or `openchat.setHeight(px)`. |
| artifact → app | `artifact:result` | `{ title?, text?, data?, nonce }` | `openchat.result(payload)`; becomes a draft, never markup. |
| app → artifact | `artifact:reset` | `{ nonce }` | The viewer's reset action when the handshake completed; the shim reloads its own document. |

There is no `artifact:error` message: neither architecture document names one,
so the viewer drops unknown types rather than inventing a channel. A broken
artifact is still caught by the shell (slice 3) and by the viewer's existing
load timeout.

`artifact:init` also carries the artifact id, as the table in
`04-artifact-sandbox.md` shows; the shim ignores it beyond the handshake.

## Identity, not origin

- The viewer accepts a message only when `event.source === iframe.contentWindow`
  **and** `data.nonce` equals the nonce minted for this viewer epoch (see
  below).
- `event.origin` is never consulted. A document under `sandbox="allow-scripts"`
  without `allow-same-origin` has an opaque origin and reports `"null"`; an
  origin check would reject the real artifact and accept any other opaque frame.
- The shim accepts `artifact:init` only from `window.parent`. Same rule, mirrored.
- The nonce is 16 random bytes as 32 hex characters (`crypto.getRandomValues`).
  It is not a credential: it proves "this is the frame I created", nothing more.
  It is scoped to the viewer epoch (`useMemo(…, [epoch])`), not to one document:
  an in-place reset reloads the document and keeps the nonce, and a new URL on
  the same epoch (pre-expiry refresh, recovery, retry) reuses it too. A reset
  that remounts the frame bumps the epoch and mints a new one, so the old
  frame's messages die.
- Everything else is dropped without a response: a foreign source, a wrong
  nonce, an unknown type, a malformed body.

## Limits

| Limit | Value | Enforced by |
| --- | --- | --- |
| Height | integer 80…4000 px | viewer clamps both sides; the shim clamps before sending |
| Result | ≤ 64 KiB of JSON (`title + text + data`) | shim refuses to post; viewer refuses to accept |
| Result rate | one accepted result per 500 ms | viewer |
| Title | 200 code points | both ends truncate |
| Reposts | initial `init` + 2, then silence | viewer |
| Target origin | `"*"` | both ends; safe because the frame is the only recipient and carries no credential |

A result is an editable draft, never HTML: the viewer validates the shape,
drops unknown fields, and keeps `{ title?, text?, data? }` as a draft. Nothing
in the payload is parsed as markup: the title and text are `<input>` and
`<textarea>` values, and `data` is a `<pre>` of pretty-printed JSON. A test
feeds `<img src=x onerror=alert(1)>` in both fields and asserts that it stays
literal text and creates no element.

## Result → editable draft in the viewer

The `/artifacts/:id` route has no session and no composer, so the draft is
local to the viewer: `ArtifactViewer` keeps the accepted result in its own
state and renders `DraftPanel` below the frame until the user dismisses it.
The panel offers **Copy** (title, text and JSON `data` as one plain-text
payload, with a short "Copied" acknowledgement that resets) and **Dismiss**.
There is no send button, because there is no session to send to; inventing one
would imply a conversation this route does not have.

`onArtifactResult` remains the seam for the one surface that will have a
composer: the inline artifact card in a message. The viewer calls it from the
same handler that stores the draft, so a caller sees exactly the result the
panel shows — one result path, not two.

**The overwrite rule.** A result never silently replaces text the user typed:

- The first result (or the first after Dismiss) starts a fresh draft.
- While the draft is untouched, a newer result replaces it in place — a
  calculator that re-posts on every input keeps its panel current.
- Once the user edited the title or the text, a different result only raises
  the "New result available" affordance; clicking it replaces the draft and
  clears the edited flag. An identical result is ignored either way, so a
  repeated payload causes no churn.

Dismiss clears the panel; a later result starts a fresh draft, even when it is
identical to the dismissed one. The panel is a labelled `region`, and it never
takes focus when it appears: keyboard focus stays on whatever control the user
was using.

## Reset semantics

The viewer's Reset control (`artifact-reset` test id, `artifacts.reset`
catalogue key) restarts the app **without minting**:

1. If the frame completed the handshake, the viewer posts `artifact:reset` with
   the current nonce. The shim reloads its own document, the iframe fires
   `load`, and the viewer sends `artifact:init` again with the same nonce. The
   signed URL is untouched.
2. If the frame never answered `ready` (plain HTML, or a document without the
   shim), the viewer remounts the iframe with the same `src`. No metadata read,
   no new signature, no navigation away from the artifact origin.

Present mode, the title chrome and the download path are unaffected. The
pre-expiry refresh still replaces the URL when the signature ages out; that is
the only path that re-mints, and it is not reset. The stale panel's Retry also
re-reads the metadata by design.

The control is labelled from `artifacts.reset` ("Reset" / "Zurücksetzen"),
which is in both locales. `artifacts.reload` remains for the stale panel's
Retry, which re-reads the metadata by design.

## Proof A — an escaping app cannot navigate or reparent the top frame

Three independent controls, all asserted in tests:

1. **Iframe attribute.** `ArtifactFrame` renders `sandbox="allow-scripts"` and
   nothing else. `allow-top-navigation`, `allow-same-origin` and `allow-popups`
   are absent (`artifact-bridge.test.tsx`).
2. **Host policy.** Every document also carries
   `Content-Security-Policy: sandbox allow-scripts`
   (`SANDBOX_POLICY` in `apps/artifact-host/src/app.ts`). The second policy
   keeps the document sandboxed even if a future embed forgets the attribute.
   `bridge.test.ts` pins the exact string and the absence of the escape flags.
3. **No origin to return to.** The document policy has no `'self'`, no remote
   source and `frame-ancestors <chat origin>`, so the frame has no URL it could
   navigate the top window to that the app would trust.

A sandboxed frame can still navigate **itself**; CSS and CSP do not stop that.
That is exactly why proof B exists — the network, not the browser policy, is
the control.

## Proof B — egress is denied

- The document policy is `default-src 'none'` with `connect-src 'none'`,
  `img-src data: blob:`, `font-src data:`, `media-src data: blob:` and
  `script-src 'unsafe-inline'` only. No host source exists for `fetch`,
  WebSocket, `EventSource`, `sendBeacon`, a remote image or a remote script.
- `apps/artifact-host/test/fixtures/cdn.html` is final HTML with
  `<script src="https://cdn.example.com/chart.js">`. The test asserts three
  things: the fixture really contains that remote script, the documented
  validator rule (no `http:` / `https:` / `//` literal) rejects it, and the
  host policy has no `script-src` source that could load it.
- The validator itself lives in slice 3 (`packages/artifact-tool`). The oracle
  in `test/fixtures/index.ts` restates its rule for this proof; it is a test
  double, not a second validator.
- The runtime host has no network namespace route at all. The fixture proves
  the document cannot even ask; the container policy proves that a
  self-navigation to `https://evil/?d=…` dies at the network. Neither proof
  requires a network call in the test suite.

## Fixtures

| Fixture | Form | What it pins |
| --- | --- | --- |
| `calculator.jsx` | JSX source for `openchat_app_write` | range + radio inputs, `aria-live` result, `openchat.result({ title, text, data })`. |
| `chart.jsx` | JSX source | local array → `<svg>` polyline (`role="img"`), `openchat.setHeight(260)`, no remote reference. |
| `broken.jsx` | JSX source | `throw` during `App()`; the shell (slice 3) owns the error panel. |
| `cdn.html` | final HTML (not compiled) | a remote `<script src>`; the validator/CSP refusal. |

All four are read from disk by the tests. No fixture, test or shim makes a
network request.

## The shell wiring (done)

The shell inlines the shim **before** the app bundle, inside the same document,
so `window.openchat` exists when the compiled IIFE runs:

```ts
import { BRIDGE_SCRIPT } from "@openchat/artifact-host/bridge"

const html = `<!doctype html><html>…<body><div id="root"></div>
<script>${BRIDGE_SCRIPT}</script><script>${bundle}</script>
</body></html>`
```

This is wired: `packages/artifact-tool/src/shell.ts` returns `BRIDGE_SCRIPT`
from `bridgeScript()` and emits the bridge tag first, and
`@openchat/artifact-tool` depends on `@openchat/artifact-host` (`workspace:*`).
`compile.test.ts` pins the bridge text, its position ahead of the bundle, and
the two script elements, so the order cannot regress silently.

The import resolves through the `./bridge` subpath export in
`apps/artifact-host/package.json`. Do not minify or wrap the shim in a module:
it is a classic script, and the shell is one portable document.

The shim expects `#root` to exist at `DOMContentLoaded` (the shell already
renders `<div id="root"></div>`) and sets `data-theme` and `color-scheme` on
`<html>` from `artifact:init`, so the shell's tokens can follow the app theme.

## Tests

| File | Pins |
| --- | --- |
| `apps/artifact-host/test/bridge.test.ts` | API shape; no send before init; init only from `window.parent`; queued/immediate `onInit`; result shape, nonce and 64 KiB refusal; `ResizeObserver` height plus `setHeight` clamping; reset nonce; no `fetch`/storage/`eval`/`window.open`/`</script` in the script text; sandbox policy; document policy; the `cdn` fixture and the validator oracle; the four fixtures. |
| `apps/web/test/artifact-bridge.test.tsx` | init payload/target/nonce on load; exactly two reposts with the same nonce; ready stops reposts; the repost timer is cleared on unmount; resize clamp and frame height; `clampHeight` refuses `NaN`/`±Infinity`; foreign source and wrong nonce dropped; 65 KiB dropped; 10 Hz stream rate-limited; the callback and the panel's field value come from one result, no HTML injection; bridge reset with a ready frame; remount reset with the same URL and a fresh nonce; sandbox attribute; unknown type dropped. |
| `apps/web/test/artifact-viewer.test.tsx` | (slice 2, updated) reset reuses the signed URL and performs no metadata read; present/Escape unchanged; a result renders locally with no callback; no panel before the first result. |
| `apps/web/test/artifact-draft.test.tsx` | no panel before the first result; title/text/JSON `data` prefilled; generic title fallback; an untouched draft follows the artifact; an edited draft keeps its text and only offers a labelled "New result available" that replaces on click; Copy writes the draft to the clipboard and resets its acknowledgement; Dismiss clears and the next result shows again; `<img src=x onerror=…>` stays literal text; focus is not stolen; the callback and the panel come from one result path. |
| `apps/web/e2e/artifacts.spec.ts` | (slice 2, updated) the seeded document is built through the real shell, so the handshake happens; reset keeps the same iframe element and signed URL, reloads the document in place and issues no `/api/artifacts/:id` read. |

## Deliberately not in this slice

- **No `artifact:error`.** Not documented; inventing one would add a channel the
  shell cannot send yet.
- **No send / composer insertion from the viewer.** The panel drafts, copies and
  dismisses; `onArtifactResult` is the seam an inline chat card can use to insert
  into a composer later.
- **No per-artifact result quota beyond 500 ms.** The 64 KiB cap and the rate
  limit are the documented bounds; a daily quota has no product requirement.
