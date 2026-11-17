# 02 — Surface Inventory

**Status:** first desktop pass done (OBS-010 … OBS-019). Rows still marked
`open` need a dedicated probe before they become requirements.

Legend: `observed` = seen with an evidence ID; `partial` = some parts observed;
`open` = not yet probed; `deferred` = consciously out of v1.

## App shell

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| Sidebar | brand + account menu, search, collapse, New chat, Plan, Library, Plugins, Discover, Pinned, Projects, Recent, profile footer | OBS-010, OBS-011 | observed |
| Header | sidebar/menu toggle, title menu, share, one trailing icon; the reference has a Chat/Work switch (OBS-013), excluded from our product | OBS-010, OBS-013, OBS-015, OBS-029 | observed |
| Thread | labelled message groups, assistant blocks, actions, scroll-to-bottom | OBS-015, OBS-017 | observed |
| Composer | pill shell, plus + add menu, text field, effort/model picker, dictation, voice, send/stop, expand | OBS-012, OBS-014, OBS-018, OBS-036 | observed |
| Right rail | artifact / canvas / file preview | — | open |
| Overlays | model picker, title menu, share, settings | OBS-014, OBS-029 | partial |

## Entry

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| New chat | H1, composer, add menu, 0–3 suggestion chips (rows on mobile), temporary-chat button | OBS-012, OBS-013, OBS-019, OBS-035, OBS-036 | observed |
| Empty history | empty state, recent chats | — | open |
| Onboarding | hints, feature tour | — | open |

Suggestion chips are account-personalized in the reference (OBS-019). Our
product must not personalize by default.

## Chat

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| Assistant message | text blocks, headings, lists, tables, code, math, diagrams, actions | OBS-016, OBS-017 | observed |
| User message | right-aligned bubble, link detection, copy/share/edit | OBS-015, OBS-017, OBS-028 | observed |
| Streaming | thinking status, stop button, disabled share, auto title | OBS-015 | observed |
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
| Deep research / Plan | plan, progress, sources, report | — | open |
| Image generation | prompt, style, gallery, edit | — | open |
| Voice | recording, waveform, transcript | — | open |
| Permissions | approve/deny, "always allow" | — | open |

## Organization

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| History | Pinned / Projects / Recent grouping, rename, delete | OBS-011 | partial |
| Projects | instructions, files, chats, context | OBS-011 | partial |
| Tasks ("Plan") | schedule, status, recurrence | — | open |
| Plugins / Discover | catalog, detail, connectors | — | open |
| Library | images, files, artifacts | — | open |

## Settings

| Surface | Parts | Evidence | Status |
| --- | --- | --- | --- |
| Settings shell | 340 px sidebar, search, Back to app, grouped rows, 768 px content | OBS-037 | observed |
| Appearance | theme mode, preset, accent/background/foreground, advanced | OBS-037 | observed |
| Models | selection, limits, features | OBS-014 | partial |
| Account, billing, parental controls, pets | reference account chrome | OBS-037 | not applicable (single user, self-hosted) |
| Personalization | instructions, memory, tone | OBS-019 | reference only |
| Connectors | MCP/apps, auth status, tools | — | open |
| Data | export, delete, retention | — | open |

## States

| State | What to observe | Evidence | Status |
| --- | --- | --- | --- |
| Loading | skeleton, spinner, progress | OBS-015 | partial |
| Empty | empty states, CTAs | OBS-012 | partial |
| Error | network, model, tool, permission | — | open |
| Offline | banner, retry, cache | — | open |
| Cancellation | stop, partial answer, resume | — | open |
| Length | compaction, "continue" | — | open |
| Rate limit | notice, wait time, fallback | — | open |

## Responsive

| Width | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| ≥ 1024 px | sidebar 340 px + content column; thread capped at 768 px | OBS-010, OBS-035 | observed |
| 768–1023 px | sidebar stays 340 px; thread shrinks with ~32 px insets | OBS-035 | observed |
| 640–767 px | sidebar becomes a drawer; composer still one row | OBS-035 | observed |
| < 640 px | two-row composer, 16 px inset, full-width suggestion rows | OBS-028, OBS-035 | observed |
