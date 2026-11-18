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

Root layout: a slim bar (`role="region"`, labelled, `tabIndex={-1}` so it can
receive focus) and a content area that fills the rest. The bar holds the switch,
the connection state (`role="status"`, with a spinner while loading), Reload,
"Open Code in a new tab" and, while a frame is up, "Focus Code".

**Two tickets per load.** The frame URL and the new-tab URL each come from
`GET /api/code/ticket`; the exchange is single use, so sharing one URL would
401 in the second tab. Both are minted together with the status probe in one
`Promise.allSettled`. Reload and the sign-in retry mint a fresh pair. At most
two mints per load stay well inside the BFF's 20-per-minute limit.

The frame is only mounted once the ticket and a reachable status are known; the
frame area itself is always rendered while loading, so the layout does not
jump. `src` is the ticket URL, `title` is translated, and `allow` is
`clipboard-read; clipboard-write`. That is the whole delegation: the Code UI
copies code and output and pastes into its editor. Camera, microphone,
geolocation, popups and top navigation stay with the app.

## States

| State | Detected by | UI |
| --- | --- | --- |
| Loading | no ticket yet, or `load` has not fired | bar shows a spinner and "Loading…"; frame area keeps its size |
| Code host down | `status.reachable === false`, a rejected status call, or a rejected ticket call | alert panel: "Code host unreachable", the failing probe or ticket, the expected version, Retry |
| Version mismatch | `status.matches === false` (and reachable) | non-blocking warning under the bar; the frame loads |
| Unauthenticated | `message` from the ticket URL's **exact origin** with `{type: "openchat:code-state", state: "unauthenticated"}` | "Sign in to open Code" panel; the button re-mints and reloads |
| Embedding blocked | `load` did not fire within `CODE_LOAD_TIMEOUT_MS` (15 s, `loadTimeoutMs` prop for tests) | explanation and the new-tab fallback; the frame is unmounted |
| Offline | `navigator.onLine` false on mount or an `offline` event | banner, no frame, no ticket minted; coming back online remints |
| Mobile (`< lg`) | `useMediaQuery("(min-width: 1024px)")` false | desktop-orientation notice and the new-tab link; no frame and no fake narrow layout |

Event origin checks: the listener ignores any other origin and any other
payload; the app never trusts `postMessage` content from a foreign page.

`Escape` returns focus to the bar when focus is anywhere outside it (for
example after the frame element was focused). A key pressed *inside* the
cross-origin frame never reaches this window, so the app cannot react to it —
that is a browser boundary, not something the UI fakes.

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
successful send clears both; a failed send keeps the text and the draft. The
landing page has no session yet and does not pass a key.

## Deliberate deviations and gaps

- **Bar layout.** Spec 13 asks for the switch as the leading control "in the
  header". The chat pages had no shared desktop header (each page owns its
  title bar), so `AppShell` gained a slim 48 px app bar at every width that
  hosts the switch; `ChatPage` keeps its own title header below it. The
  alternative — a switch inside each page header — would have scattered the
  control and risked two switches. On `/code` the app bar is not rendered, so
  there is still exactly one.
- **`Escape`.** Implemented only for keys the app can observe (see above).
  Focus goes to the bar container, not to a specific button, so the next Tab
  starts at the switch.
- **Sidebar hidden on `/code`.** The spec says the Code surface uses the full
  width, so the sidebar cannot be used while in Code. "Opening a session from
  the chat sidebar while in Code switches to Chat" is therefore implemented as
  a route rule: any navigation to a chat route stores `chat`, and the switch
  follows the route. The same rule covers back/forward and links from search.
- **Second ticket for the new tab** (see above). The visible control is a real
  `<a target="_blank" rel="noopener noreferrer">`; when its ticket could not be
  minted it renders disabled instead of pointing at a consumed URL.
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
- **No E2E stub host yet.** The ticket exchange and framing are covered by the
  Code host's own suite; the browser-level framing check stays a deploy-time
  step.
- **No screenshot route yet.** The screenshot harness has no Code route; a
  stable Code frame needs a stub host.

## Tests

| File | Covers |
| --- | --- |
| `test/code-surface.test.tsx` | switch renders with `aria-pressed` and follows the route; storage round trip; `/` restores Code; shortcut toggles and ignores other keys; hidden and inert when unconfigured; app bar and sidebar absent on `/code`; sidebar navigation stores `chat`; helper tables (route mapping, malformed/denied storage, deep-link mapping). |
| `test/code-page.test.tsx` | deep-link suffix reaches the ticket call; root `next`; frame `src`, `title`, `allow`; distinct new-tab ticket; loading state and `load`; ticket error and Retry; unreachable status with expected version; mismatch warning without blocking; foreign-origin message ignored, Code-host origin signs out, sign-in re-mints; blocked timeout; offline; mobile notice; reload re-mints and keeps one switch; `Escape` focus; unconfigured `/code` redirect. |
| `test/drafts.test.tsx` | per-session set/get/clear, empty write removes, missing session/storage; Composer survives a remount, keeps a failed draft, clears on success, reloads the draft when the key changes. |
| `test/app-shell.test.tsx` | existing drawer behaviour with the switch inside the app bar. |

All component tests mock `../src/api/client`; no test reaches a BFF or a Code
host.
