# 02 — Information Architecture

**Status:** structure confirmed by the desktop and mobile passes
(OBS-010 … OBS-037); routes that depend on unobserved surfaces stay marked
`open` in the surface inventory.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | New chat / landing |
| `/c/:sessionId` | Chat thread |
| `/c/:sessionId/:messageId` | Deep link to a message |
| `/code` | Code surface: the original OpenCode web UI (proposed) |
| `/search` | Global chat search |
| `/search?scope=all` | Multi-source search: chats, workspace, web, apps (proposed) |
| `/apps` | Connected apps, MCP servers, tools and skills (proposed) |
| `/projects` | Project list |
| `/projects/:projectId` | Project detail: instructions, files, chats |
| `/tasks` | Scheduled and background tasks |
| `/library` | Generated images, files and artifacts |
| `/settings` | Settings root |
| `/settings/models` | Model and provider view |
| `/settings/agents` | Agents and permissions |
| `/settings/connectors` | MCP servers and apps |
| `/settings/appearance` | Theme, language, accessibility |
| `/settings/data` | Export, delete, retention |
| `/login` | Login form |

Artifacts are not an app route. The app shows metadata and embeds a signed URL
on the separate artifact origin (`/a/<id>?exp=…&sig=…`); it never serves artifact
HTML from the app origin. The library route lists artifacts and generated media.

Projects and tasks are **deferred** from v1: OpenCode 2.3 exposes no
project-creation API and v1 runs in a single `WORKSPACE_DIR`. Artifacts,
media and the library are in v1 (M4). The routes above are the target, not all
of them the first slice.

## Shell

### Desktop (≥ 1024 px)

```
┌──────────────┬──────────────────────────────────────────────┬─────────────┐
│ Sidebar      │ Header: title · model · agent · share         │ Right rail  │
│              ├──────────────────────────────────────────────┤ (optional)  │
│ + New chat   │ Thread                                       │ Artifact    │
│ Search       │                                              │ Canvas      │
│ Library      │                                              │ Files       │
│ Projects     │                                              │             │
│ Tasks        │                                              │             │
│ History      ├──────────────────────────────────────────────┤             │
│              │ Composer                                     │             │
│ Profile      │                                              │             │
└──────────────┴──────────────────────────────────────────────┴─────────────┘
```

### Tablet (640–1023 px)

- Sidebar collapses to an overlay drawer.
- Right rail becomes a full-height sheet over the thread.
- Composer stays pinned to the bottom.

### Mobile (< 640 px)

- One column. Header shows back, title and overflow.
- Sidebar and right rail are separate routes or full-screen sheets.
- Composer uses a compact toolbar; attachments open a sheet.

## Sidebar sections

Observed order (OBS-011):

1. Brand row with account menu, search and sidebar collapse.
2. New chat.
3. Plan (tasks and scheduled work).
4. Library.
5. Plugins.
6. Discover.
7. Pinned chats.
8. Projects, expandable to their chats.
9. Recent chats, single line, truncated.
10. Profile footer with display name and plan/status line.

Rules:

- Sections are collapsible and remember their state.
- Only one row carries a persistent selected background at a time.
- Projects expand inline; their chats are indented under the project.
- Recent chats show a trailing status indicator while a run is active.
- The sidebar scrolls independently of the thread.

## Header

- Surface switch at the leading edge: **Chat** and **Code** (proposed
  2026-11-17). It is not the reference Chat/Work switch; it chooses between our
  transcript and the original OpenCode web UI. The choice persists per owner;
  `Cmd/Ctrl+Shift+O` toggles it. On mobile it collapses into the overflow menu.
- In the Code surface the app chrome shrinks to a slim bar with the switch and
  a reload action, so the embedded UI gets the space.
- Sidebar toggle (desktop) or back (mobile).
- Session title as a menu trigger. Observed actions (OBS-029): rename, pin,
  plugins submenu, lock chat, show files in chat, archive, delete, move to
  project. Our v1 ships rename, pin, archive, delete, export; the rest appear
  only when the corresponding feature exists.
- A destructive action sits in the same menu but requires a confirmation step
  and is visually marked; the reference does not separate it.
- Share action, disabled while a turn is streaming (OBS-015).
- One trailing icon for the session-level panel (currently account/workspace
  actions in the reference).
- **No Chat/Work switch.** The reference has a mode switch (OBS-013); the Work
  surface is out of scope, so that switch is not rendered at all. The Chat/Code
  switch above selects between our surface and OpenCode's, not a reference mode.

## Code surface (proposed)

- `/code` embeds the original OpenCode web UI for the same OpenCode server.
- The embedded surface owns its own navigation; the app does not reimplement
  OpenCode's screens.
- The switch is the only app chrome that stays visible; a slim bar carries
  reload, open-in-new-tab and back-to-Chat.
- The embedded UI is authenticated by the app. OpenCode is never reachable
  unauthenticated.
- If embedding fails (CSP, third-party cookies, unsupported browser), show the
  reason and a button that opens the Code host in a new tab.
- Deep links: `/code` accepts a path suffix and passes it to the embedded UI so
  the owner can bookmark a session or settings page.

## Search surfaces (proposed)

- `/search` today means chat history. With `scope=all` it groups results by
  source: chats, workspace files, web, connected apps.
- Each group has a label, a count and a toggle; disabled sources are not
  queried.
- Web results show provider and citation; workspace results show path; app
  results show server/tool and status.
- `/apps` lists MCP servers, tools and skills with status and connect actions.
- Search never sends secrets or private data to a provider unless that source
  is enabled and the query is explicit.

## Landing surface

Ordered top to bottom (OBS-012):

1. Temporary-chat button in the shell (no mode switch; see the header rules).
2. Centered H1, one line. The reference rotates the copy (OBS-019), so the
   heading is a variant set, not a constant.
3. Composer.
4. Zero to three suggestion chips or full-width suggestion rows on mobile;
   absent in a fresh state (OBS-019, OBS-035).

The reference personalizes the suggestion chip from account memory (OBS-019).
Our product shows a static suggestion, a recent local chat, or nothing; it
never derives suggestions from stored personal data unless the owner enables it.

Temporary chat: a session that is not written to history. In scope only if the
storage layer can enforce it; otherwise hide the control instead of faking it.

## Composer

- Multiline text field with auto-grow.
- Attachment button, tool menu, model selector, send/stop.
- Attachment chips above the field.
- Hints for supported tools and permissions.
- Draft persistence per session.

## Command palette

Global shortcut (`Ctrl/Cmd+K`):

- new chat
- search chats
- switch model
- switch agent
- open settings
- toggle theme
- open OpenCode settings

## Empty and error states

Every route defines:

- loading skeleton,
- empty state with one primary action,
- error state with retry and a link to diagnostics,
- offline state with cached content where possible.

## Deep links

- Session and message links are stable.
- Artifact links point to the sandbox origin, never to the app origin.
- OpenCode settings link is configurable and must not leak the internal URL.
