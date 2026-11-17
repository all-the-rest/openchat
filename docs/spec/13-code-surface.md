# 13 — Code Surface

**Status:** proposed for **V2** (owner, 2026-11-17). Not part of v1.

The Code surface shows the **original OpenCode web UI** for the same OpenCode
server, inside the app. It is not a rebuild and not a reference clone: OpenCode
ships its own interface, and the owner wants one front door for chats and for
the workspace. If embedding turns out to be impractical, V2 builds an
equivalent surface ourselves instead of dropping the switch.

## Why

- The owner wants to run OpenCode on a remote machine and still have one place
  to chat, inspect sessions and configure the workspace.
- Rebuilding OpenCode's screens would duplicate upstream and break on every
  upgrade. Embedding keeps their UI intact.
- It replaces the narrower "admin proxy" idea: the Code surface is the full
  OpenCode UI, behind the app's auth.

## Surface switch

- Leading control in the header: **Chat | Code**.
- Persisted per owner (`surface=chat|code`), default `chat`.
- `Cmd/Ctrl+Shift+O` toggles; the switch is a real segmented control with
  `aria-pressed`, not a link.
- On mobile it lives in the header overflow; switching does not lose the chat
  draft.
- The app never renders a Chat/Work switch (the reference mode is out of scope).

## Behavior

- `/code` loads the Code host in an iframe that fills the content area.
- A slim bar carries: switch, reload, open-in-new-tab and the connection state.
- The embedded UI owns its own navigation and shortcuts. The app does not proxy
  clicks or rewrite its DOM.
- Deep link `/code/*` passes the suffix to the embedded UI.
- If the owner opens a session from the chat sidebar while in Code, the app
  switches to Chat.

## Authentication

- The Code host is never unauthenticated. The app mints a short-lived,
  single-use ticket and the Code host exchanges it for its own host-only
  session cookie. See [`../architecture/06-code-surface.md`](../architecture/06-code-surface.md).
- No OpenCode Basic credential reaches the browser.
- No cookie is shared with the artifact origin.
- Opening the Code host directly without a ticket redirects to the app login.

## States

| State | UI |
| --- | --- |
| Loading | slim bar with a progress indicator; the frame keeps its size |
| Unauthenticated | "Sign in to open Code" with a button that re-runs the ticket flow |
| Code host down | error panel with the upstream status and a retry |
| Embedding blocked | explanation and "open in a new tab" |
| Version mismatch | warning when the Code host version differs from the BFF's pinned client |
| Offline | banner; do not silently show a cached Code UI |

## Responsive

- Desktop: the Code surface uses the full width; the chat sidebar is hidden.
- Tablet: same, with the slim bar.
- Mobile: the Code UI is often desktop-oriented. Show a notice and offer a new
  tab; do not fake a mobile layout for it.

## Accessibility

- The switch is keyboard-operable and labelled.
- Focus moves into the frame only on request; `Escape` returns focus to the
  slim bar when the frame does not consume it.
- The iframe has a title.

## Non-goals

- Rebuilding OpenCode screens.
- Public or multi-user access to the Code surface.
- Sharing OpenCode cookies with artifacts or third parties.
- Supporting an OpenCode version other than the pinned one.
