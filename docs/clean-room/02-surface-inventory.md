# 02 — Surface Inventory

**Status:** skeleton. Observation pending; every line needs an evidence ID
before it moves into the specification.

## App shell

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| Sidebar | logo/new chat, search, library, projects, GPTs/apps, tasks, history, profile | — | open |
| Header | model/agent picker, title, share, overflow | — | open |
| Thread | messages, separators, date, scroll anchor, "jump to latest" | — | open |
| Composer | text field, attachments, tools, model, send/stop | — | open |
| Right rail | artifact/canvas/file preview | — | open |
| Overlays | model picker, tool menu, share, settings, search | — | open |

## Entry

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| New chat | greeting, suggestion chips, composer, tool hints | — | open |
| Empty history | empty state, recent chats | — | open |
| Onboarding | hints, feature tour | — | open |

## Chat

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| Assistant message | text, reasoning, tool calls, sources, actions | — | open |
| User message | text, attachments, edit, copy | — | open |
| Streaming | cursor, stop, partial state, auto-scroll | — | open |
| Errors | retry, error text, model switch | — | open |
| Branching | edit and regenerate, branch history | — | open |
| In-chat search | hits, navigation | — | open |

## Tools and agents

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| Tool call | name, status, duration, input/output, error | — | open |
| Web search | search progress, sources, citations | — | open |
| Code/data analysis | runtime, files, charts, downloads | — | open |
| Browser/agent | live view, steps, takeover | — | open |
| Deep research | plan, progress, sources, report | — | open |
| Image generation | prompt, style, gallery, edit | — | open |
| Voice | recording, waveform, transcript | — | open |
| Permissions | approve/deny, "always allow" | — | open |

## Organization

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| History | grouping, rename, delete, archive | — | open |
| Projects | instructions, files, chats, context | — | open |
| Tasks | schedule, status, recurrence | — | open |
| GPTs/apps | catalog, detail, start, connectors | — | open |
| Library | images, files, artifacts | — | open |

## Settings

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| Account | profile, login, sessions | — | open |
| Personalization | instructions, memory, tone | — | open |
| Models | selection, limits, features | — | open |
| Connectors | MCP/apps, auth status, tools | — | open |
| Data | export, delete, retention | — | open |
| Appearance | theme, language, accessibility | — | open |

## States

| State | What to observe | Evidence | Status |
| --- | --- | --- | --- |
| Loading | skeleton, spinner, progress | — | open |
| Empty | empty states, CTAs | — | open |
| Error | network, model, tool, permission | — | open |
| Offline | banner, retry, cache | — | open |
| Cancellation | stop, partial answer, resume | — | open |
| Length | compaction, "continue" | — | open |
| Rate limit | notice, wait time, fallback | — | open |
