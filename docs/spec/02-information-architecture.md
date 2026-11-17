# 02 — Information Architecture

**Status:** target structure derived from the product goals. Reference-specific
wording and visual grouping are pending observation.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | New chat / landing |
| `/c/:sessionId` | Chat thread |
| `/c/:sessionId/:messageId` | Deep link to a message |
| `/search` | Global chat search |
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
| `/artifact/:artifactId` | Sandboxed artifact host (separate origin) |

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

1. New chat
2. Search
3. Library
4. Projects
5. Tasks
6. Chat history, grouped by date
7. Profile and settings

Order and grouping are provisional; the reference observation may adjust them.

## Header

- Back (mobile) or sidebar toggle (desktop).
- Session title, inline editable.
- Model selector.
- Agent selector.
- Share/export.
- Overflow: rename, archive, delete, branch, settings.

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
