# 07 — Code UI: switch, `/code` route and drafts

**Status:** 2026-11-18. Implements the web half of issue #11: the Chat | Code
switch, the `/code` route with its deep links, the slim bar, the embedding
states and the session draft store. The BFF endpoints
(`GET /api/code/ticket`, `GET /api/code/status`, `InfoResponse.code`) and the
Code host already exist; see
[`06-code-surface.md`](./06-code-surface.md).

Spec: [`../spec/13-code-surface.md`](../spec/13-code-surface.md). Architecture:
[`../architecture/06-code-surface.md`](../architecture/06-code-surface.md).

## Files

| File | Responsibility |
| --- | --- |
| `src/code/surface.ts` | Pure surface helpers: storage key, route mapping, `next` mapping. |
| `src/code/SurfaceProvider.tsx` | `code.configured` from `/api/info`, persistence, shortcut, `/` restore. |
| `src/code/SurfaceSwitch.tsx` | The segmented control. |
| `src/code/CodePage.tsx` | `/code` and `/code/*`: bar, ticket minting, states, frame. |
| `src/chat/drafts.ts` | Pure `sessionStorage` draft helpers. |
| `src/api/client.ts` | `codeTicket(next)` and `codeStatus()`. |
| `src/lib/useOnline.ts` | `navigator.onLine` with the window's online/offline events. |

## Surface switch

- A `role="group"` with two real buttons, `Chat` and `Code`, each carrying
  `aria-pressed`. Not links: choosing a surface is app navigation, and the
  pressed state must reflect the route even when a deep link was opened.
- **The route is the source of truth.** `surfaceForPath` maps `/code` and
  `/code/*` to `code` and every other protected path to `chat`. The stored
  value is read for two things only: the shortcut's starting direction and the
  `/` restore (below).
- **Persistence.** `localStorage["openchat.surface"]` holds `chat` or `code`;
  a missing or malformed value reads as `chat`. Storage failures (private mode,
  blocked partition) are swallowed and the in-memory choice still applies.
- **Choosing** writes the value and navigates: Code to `/code`, Chat to `/`.
  Every route change to a chat route (a session link, search, the switch)
  rewrites the stored value to `chat`, so a later visit to `/` stays in chat.
  The initial path is skipped: `/` must be able to restore `code`.
- **Restoring.** `SurfaceHome` wraps the `/` route: on a fresh app boot
  (`location.key === "default"`), when `/api/info` reports a configured Code
  host and the stored value is `code`, `/` redirects to `/code` (replace).
  Client-side arrivals at `/` (Back, a link) keep their own history key and
  stay in chat. That is the only place the stored value changes the route; a
  deep link or a chat URL always wins.
- **Shortcut.** `Cmd/Ctrl+Shift+O` toggles. It is registered only when
  `code.configured === true`, ignores `Alt`, other keys and other modifier
  combinations, and calls `preventDefault` because the same chord opens the
  browser's bookmark manager.
- **Unconfigured.** `code.configured === false` (or a failed `/api/info`) means
  the switch renders nothing, the shortcut does nothing and `CodeRoute`
  redirects a direct `/code` visit to `/`. While the info request is in flight
  the switch is hidden as well; there is no separate request.

### One switch at a time

`AppShell` renders the app bar with the switch on chat routes. On `/code` the
app bar is not rendered at all and the Code page's own slim bar carries the
switch, so exactly one switch is in the DOM. Hiding the drawer on `/code` also
keeps the chat sidebar out of the way; the Code surface owns the full width.

## Routes

| Route | Behaviour |
| --- | --- |
| `/code` | Frame at `next=/`. |
| `/code/*` | Frame at `next=<suffix>`; empty segments collapse, so `/code/workspace/x` is `/workspace/x` and `/code//x` is `/x` (never `//x`). |
| `/` | Chat landing; restores `/code` from storage when Code was the last surface. |
| `/c/:id`, `/search` | Chat, unchanged. |

The suffix is computed from `location.pathname` via `codeDeepLink` and passed to
`GET /api/code/ticket?next=…`. The BFF sanitises it and the Code host validates
it again; the client deliberately does not duplicate those checks.

## The `/code` page

Root layout: a slim bar and a content area that fills the rest. The bar is an
explicit `role="banner"` (labelled, `tabIndex={-1}` so it can receive focus),
but it sits inside `<main>` — `AppShell` wraps the outlet — so it is not a
top-level landmark. On the chat routes the app bar is the one top-level banner;
`/code` does not render it. The bar holds the switch,
the connection state (`role="status"`, with a spinner while loading), Reload,
"Open Code in a new tab" and, while a frame is up, "Focus Code". The secondary
actions are outlined buttons, so they read as controls at a glance; below `lg`
the new-tab control shortens to "New tab" so the 390 px bar stays on one row.
The app name appears in the chat bar only below `lg`, because the desktop
sidebar already carries it.

**Two tickets per load.** The frame URL and the new-tab URL each come from
`GET /api/code/ticket`; the exchange is single use, so sharing one URL would
401 in the second tab. Both are minted together with the status probe in one
`Promise.allSettled`. Reload and the sign-in retry mint a fresh pair. A load is
therefore two mints in a production build and four under React StrictMode in
development, where the dev server double-invokes the effect; both stay inside
the BFF's 20-per-minute limit.

The frame is only mounted once the ticket and a reachable status are known; the
frame area itself is always rendered while loading, so the layout does not
jump. `src` is the ticket URL, `title` is translated, and `allow` is
`clipboard-read; clipboard-write`. That attribute delegates clipboard access
only: it neither grants nor blocks popups or top-level navigation, which an
`allow` list does not control at all — only a `sandbox` would. The frame has no
sandbox (see the deviations), so browser defaults govern those, not this
attribute. Camera, microphone and geolocation are not listed and stay with the
app.

## States

| State | Detected by | UI |
| --- | --- | --- |
| Loading | wide layout, and no ticket yet or `load` has not fired | bar shows a spinner and "Loading…"; frame area keeps its size |
| Code host down | `status.reachable === false` or a rejected status call | alert panel: "Code host unreachable", the failing probe, the expected version, Retry |
| Ticket failure | a rejected `GET /api/code/ticket` (for example the BFF's `429` from the 20-mints/minute budget) | its own panel: "No Code sign-in ticket", the ticket limit, Retry; no expected-version line, because the host is not the failure; the bar says "Sign-in failed", not "Not reachable" |
| Version mismatch | `status.matches === false` (and reachable) | non-blocking warning under the bar; the frame loads |
| Unauthenticated | `message` from the ticket URL's **exact origin** with `{type: "openchat:code-state", state: "unauthenticated"}` | "Sign in to open Code" panel; the button re-mints and reloads |
| Embedding blocked | wide layout, and `load` did not fire within `CODE_LOAD_TIMEOUT_MS` (15 s, `loadTimeoutMs` prop for tests) | explanation and the new-tab fallback; the frame is unmounted. This is the never-loads case only; see the H1 limitation below. |
| Offline | `navigator.onLine` false on mount or an `offline` event | banner, no frame, no ticket minted; coming back online remints |
| Narrow (`< lg`) | `useMediaQuery("(min-width: 1024px)")` false | bar says "Desktop only"; desktop-orientation notice and the new-tab link; no frame, no fake narrow layout, and the load timer never starts |

Event origin checks: the listener ignores any other origin and any other
payload; the app never trusts `postMessage` content from a foreign page.

`Escape` returns focus to the bar when focus is anywhere outside it (for
example after the frame element was focused). The bar has a visible
`focus-visible` outline; the old `outline-none` was removed because spec 09
forbids dropping a focus indicator without a replacement. A key pressed
*inside* the cross-origin frame never reaches this window, so the app cannot
react to it — that is a browser boundary, not something the UI fakes.

## Draft preservation

`src/chat/drafts.ts` is a pure module over an injected `Storage`:

- key `openchat.draft.<sessionID>` in `sessionStorage` (per tab, per session);
- `readDraft` returns `""` for a missing entry, an empty session id or an
  unavailable storage;
- `writeDraft` removes the entry when the text is empty instead of storing `""`;
- `clearDraft` removes it.

`Composer` takes an optional `draftKey` (the session id on `ChatPage`). It
loads the draft on mount and when the key changes — React reuses the component
across `/c/one` → `/c/two` — and every write goes through one `updateValue`, so
the stored copy never lags the field (including dictation inserts). A
successful send clears both; a failed send keeps the text and the draft.

The landing page has no session yet, so it passes `NEW_DRAFT_KEY` (`"new"`):
its draft lives at `openchat.draft.new` and survives a switch to Code and back.
`LandingPage` clears that entry as soon as the session is created, before it
navigates to `/c/<id>` and hands the text over as the pending prompt.

## Deliberate deviations and gaps

- **Bar layout.** Spec 13 asks for the switch as the leading control "in the
  header". The chat pages had no shared desktop header (each page owns its
  title bar), so `AppShell` gained a slim 48 px app bar at every width that
  hosts the switch; `ChatPage` keeps its own title header below it. The
  alternative — a switch inside each page header — would have scattered the
  control and risked two switches. On `/code` the app bar is not rendered, so
  there is still exactly one. The app name is hidden from `lg` up because the
  sidebar already shows it; the app bar outside `<main>` is an explicit banner
  (`role="banner"`) and therefore the single top-level landmark on a chat
  route, which also removed the screenshot harness's `data-testid` special
  case.
- **No mobile overflow menu.** Spec 02 puts the mobile switch in an overflow
  menu; v1 has no overflow menu anywhere, so the switch stays in the bar at
  every width instead of introducing a one-item menu. Recorded as an open
  question for the owner, not silently reinterpreted.
- **`Escape`.** Implemented only for keys the app can observe (see above).
  Focus goes to the bar container, not to a specific button, so the next Tab
  starts at the switch. The bar shows a visible `focus-visible` outline in
  place of the removed `outline-none`.
- **Deep links are path-only.** `codeDeepLink` maps `location.pathname`, so a
  `?query` or `#hash` typed after `/code/...` is dropped before it becomes the
  Code host's `next`. OpenCode's own client-side navigation is unaffected once
  the frame is open.
- **Sidebar hidden on `/code`.** The spec says the Code surface uses the full
  width, so the sidebar cannot be used while in Code. "Opening a session from
  the chat sidebar while in Code switches to Chat" is therefore implemented as
  a route rule: any navigation to a chat route stores `chat`, and the switch
  follows the route. The same rule covers back/forward and links from search.
- **Second ticket for the new tab** (see above). The visible control is a real
  `<a target="_blank" rel="noopener noreferrer">`; when its ticket could not be
  minted it renders disabled instead of pointing at a consumed URL. That ticket
  is a bearer credential and sits in the DOM's `href` for up to its 60 s TTL,
  even if the owner never clicks it; treat it like the exchange URL in the TLS
  proxy log (implementation 06).
- **Landing draft.** The landing page's composer keeps its text under
  `openchat.draft.new`, so switching to Code and back does not lose a prompt
  that has no session yet; the entry is cleared when the session is created.
- **`/` restore.** Persistence would otherwise have no effect; the restore is
  deliberately replace-only, only at `/`, and only on a fresh app boot
  (`location.key === "default"`), so Back or a link to `/` never bounces the
  owner into Code.
- **No auto-focus into the frame.** "Focus Code" is an explicit button; the
  frame is never focused on load.
- **No sandbox attribute.** The frame is the owner's OpenCode UI on its own
  origin and needs its own cookie and same-origin `/api` calls; a sandbox
  without `allow-same-origin` would break the ticket exchange.
- **No WebSocket.** The Code host proxies SSE only; the embed does not add a
  channel (see implementation 06).
- **No real-OpenCode browser coverage.** The stub host (`e2e/code-stub.ts`,
  below) covers the app's framing contract, the ticket exchange and the state
  channel; the real OpenCode shell is still only covered by the header-level
  spike and the Code host's own suite.
- **The screenshot frame is the stub.** `ui-review` captures the `code-stub`
  route, not the OpenCode UI; the route name and note say so.

## Known limitations

- **A frame refused by a policy still reports "Connected" (H1).** Measured in
  Chrome: a frame refused by `X-Frame-Options` or `frame-ancestors` fires
  `load` anyway, and cross-origin policy then hides whether anything rendered.
  The app cannot read the frame's document and a positive check would require a
  handshake injected into the upstream UI, which architecture 06 forbids. So
  the 15 s timeout only catches a frame that never fires `load`; a refused
  frame leaves the bar on "Connected" over an empty area. The user can always
  use the permanently visible "Open Code in a new tab"; the new tab is not
  framed and therefore not subject to the upstream frame policy. Do not "fix"
  this by claiming detection the code does not have.
- **The app origin sends no Content-Security-Policy.** `frame-src` is therefore
  not enforced by the app; the Code host's own `frame-ancestors` is the frame
  boundary that actually applies. A deployment can add a CSP at the reverse
  proxy, but this app does not ship one.
- **Open question: the shortcut is claimed twice.** Spec 09 binds
  `Cmd/Ctrl+Shift+O` to *new chat*, spec 13 binds it to the surface switch.
  This implementation follows spec 13 because new chat is not bound yet; the
  specs must be reconciled before the next slice adds the chord. Owner call,
  spec not edited here.
- **Open question: no mobile overflow menu.** Spec 02 wants the mobile switch
  in an overflow menu; v1 has no overflow menu (see the deviation above). The
  owner decides whether v1 gains one or the spec follows the implementation.

## End-to-end coverage

**Status:** 2026-11-18. The browser half of the surface is covered against a
stub Code host; the BFF routes and the Code host keep their own suites.

### The stub Code host

`e2e/code-stub.ts` is a loopback HTTP server on `http://127.0.0.1:8099`, started
as its own Playwright `webServer` by **both** `playwright.config.ts` and
`playwright.screenshots.config.ts`. The BFF is started with
`CODE_HOST_ORIGIN=http://127.0.0.1:8099` and the same `CODE_TICKET_SECRET` as
the stub, so every ticket the app mints is verified by a real `readTicket` call
with the matching audience. The stub runs under `tsx`, because
`@openchat/code-ticket` ships TypeScript with extensionless relative imports.

| Route | Behaviour |
| --- | --- |
| `GET /__health` | `200 {"ok":true,"version":"2.3.0"}`; the BFF's probe and Playwright's readiness URL. |
| `GET /__auth?ticket=…&next=…` | Valid ticket: `302` to the sanitised `next` plus an `HttpOnly` session cookie. Invalid or deliberately rejected: `401` with a page that posts `{type:"openchat:code-state",state:"unauthenticated"}` to the app origin and carries a visible marker. |
| `GET /__requests` | Request log for assertions: `kind` (`browser` or `upstream`), method, path and whether `authorization` was present. Only the scheme is recorded, never the value. |
| `GET /__upstream` | The simulated OpenCode upstream: rendering an authenticated page makes one loopback request here with `Authorization: Basic`, mirroring the credential the real Code host injects. |
| anything else | A page with `data-testid="code-stub"` that echoes the requested path in `data-testid="code-path"`. |

**What it proves, and what it does not.** It proves the app's browser contract:
the ticket URL, the redirect, framing, the deep-link `next`, the translated
frame title, the one-switch rule, the state-message channel, the credential
boundary and that a garbage or wrong-secret ticket really is rejected by
`readTicket` (not rubber-stamped by the stub). It proves nothing about the real
OpenCode shell. That remains the header-level spike plus the Code host's own
suite (implementation 06); there is no deploy-time substitute here.

**Control mechanism.** A valid ticket whose validated `next` is exactly
`/signed-out` is rejected on purpose. `/code/*` is the route that can produce
that path: `/code/signed-out` is hand-typed only (no link, switch or
fake-backend flow emits it), and the stub answers `401` by design. The
signed-out state is therefore deterministic per request and needs no second
server.

**Two honest limits** (recorded in the file header):

- The session cookie is set but not enforced. The app (`localhost:5173`) and
  the stub (`127.0.0.1:8099`) are different sites, and a `SameSite=Lax` cookie
  is not sent on a cross-site iframe request. The real host relies on a shared
  registrable domain (implementation 06); gating pages on the cookie here would
  `401` every legitimate frame.
- The stub plays its own upstream. "The upstream request carried Basic" is
  proven by that loopback hop on the server side, not by a real OpenCode.

**Ticket budget.** The suite runs against the Vite dev server, where React
StrictMode double-invokes the mint effect, so one `/code` load is four mints.
Four parallel tests would share the BFF's 20-mints-per-address budget and the
last one would get a `429` that looks like an unreachable host. Each test
therefore presents its own `X-Forwarded-For` on `/api/code/**`, and the E2E BFF
runs with `TRUST_PROXY=1`; every other spec keeps the socket address. This is
test isolation only — production configuration does not change.

### The five E2E cases

The four browser flows log in through the real form with `e2e/helpers.ts` and
guard against external hosts with `guardExternalRequests`; the ticket test uses
Playwright's request context and needs no login.

| Test | Proves |
| --- | --- |
| `the switch opens Code in a single bar and returns to chat` | The switch is visible on chat, `/code` follows the click, the frame is titled with the translated label and shows the stub marker, and `/code` has exactly one switch and no app bar or sidebar. Chat returns to `/` with the sidebar and still one switch. |
| `a deep link reaches the Code host path and survives a reload` | `/code/deep/path` arrives as `next=/deep/path` at the stub (the page echoes the path), a reload stays on the surface and re-runs the exchange with a fresh ticket. |
| `a rejected ticket shows the sign-in state and foreign messages are ignored` | A synthetic `MessageEvent` with `origin: "https://evil.test"` is ignored (bounded wait, then the frame is still visible); the stub's deliberate `/signed-out` rejection produces "Sign in to open Code" and the re-mint button. |
| `the stub rejects garbage and wrong-secret tickets and accepts a real one` | `GET /__auth` with a garbage ticket and with a correctly shaped ticket signed by the wrong secret answers `401` and sets no cookie; the same claims with the shared secret answer `302`, `Location: /valid` and the session cookie. |
| `the upstream credential never reaches the browser` | The stub's log shows the server-side request with a `Basic` authorization scheme, no browser request to the Code host origin carried any `authorization` header (also collected with `page.on("request")`), and the rendered stub page contains no credential. |

### Screenshot route

`screenshots/ui-review.config.ts` captures `code-stub` for `/code` at all four
viewports. The name and the note state exactly what the pixels are: the frame
is `e2e/code-stub.ts`, not the OpenCode UI. The capture clicks `Code` in the app
bar (a direct `/code` load would not prove the switch navigates) and waits for
the stub marker; below 1024 px the app deliberately shows its
desktop-orientation notice instead of a frame, so the same wait accepts that
notice. PNGs stay out of git; `ui-review/` is ignored.

## Tests

| File | Covers |
| --- | --- |
| `test/code-surface.test.tsx` | switch renders with `aria-pressed` and follows the route; storage round trip; `/` restores Code; shortcut toggles and ignores other keys; hidden and inert when unconfigured; app bar (`role="banner"`) and sidebar absent on `/code`; sidebar navigation stores `chat`; helper tables (route mapping, malformed/denied storage, deep-link mapping). |
| `test/code-page.test.tsx` | deep-link suffix reaches the ticket call; root `next`; frame `src`, `title`, `allow`; distinct new-tab ticket; loading state and `load`; ticket failure has its own title/body, no version line and a "Sign-in failed" bar, then Retry; unreachable status with expected version; mismatch warning without blocking; foreign-origin message ignored, Code-host origin signs out, sign-in re-mints; blocked timeout; a frame that fired `load` stays Connected past the timeout and mounted; offline; mobile notice; narrow bar says "Desktop only" and never Loading/Blocked; reload re-mints and keeps one switch; `Escape` focus reaches the bar and its visible outline class; unconfigured `/code` redirect. |
| `test/drafts.test.tsx` | per-session set/get/clear, empty write removes, missing session/storage; Composer survives a remount, keeps a failed draft, clears on success, reloads the draft when the key changes; a landing prompt survives a Chat → Code → Chat switch under `openchat.draft.new`; a landing send creates the session and the landing draft is already gone when the new route runs, with no draft for the new session id. |
| `test/app-shell.test.tsx` | existing drawer behaviour with the switch inside the app bar. |

All component tests mock `../src/api/client`; no test reaches a BFF or a Code
host. The browser-level suite and its stub are described under
[End-to-end coverage](#end-to-end-coverage).
