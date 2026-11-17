# 01 — Observation Log

**Status:** 2026-11-17. Authenticated UI observation has not started yet (the
browser with the browse extension was not connected). The entries below are
public metadata, not UI observation.

## Format

```
OBS-NNN | E0–E5 | date | surface | observation | reproduction
```

## Entries

### OBS-001 — Public app shell is reachable

`OBS-001 | E4 | 2026-11-17 | App shell | https://chatgpt.com returns HTTP 200, Content-Type text/html, title "ChatGPT", Express backend behind Cloudflare, SSR shell with a nonce-based CSP. | curl -sI https://chatgpt.com`

No statement about the authenticated UI. It only proves that the surface is
server-rendered and delivered as an app shell.

### OBS-002 — CSP `frame-src` shows rendering targets

`OBS-002 | E4 | 2026-11-17 | App shell | The CSP allows frames from *.chatgpt.site, *.embed.chatgpt.site, *.web-sandbox.oaiusercontent.com, file-frame.oaistatic.com, codepen.io, youtube.com, player.vimeo.com, google.com/maps, maps/embed, embed.apple-mapkit.com, docs.google.com, drive.google.com, onedrive.live.com, *.sharepoint.com. | curl -sI https://chatgpt.com`

Hypothesis (E0): these origins cover generative apps/widgets, the artifact
sandbox, file previews, code/embed previews, maps and third-party
integrations. The mapping must be verified before it becomes a requirement.

### OBS-003 — CSP `connect-src` shows realtime and media paths

`OBS-003 | E4 | 2026-11-17 | App shell | The CSP allows wss://*.chatgpt.com, wss://realtime.chatgpt.com, wss://multiplayer-u0.api.openai.com, wss://pages-realtime.gateway.unified-*.api.openai.com, images.openai.com, cdn.openai.com, checkpoints-*.files.openai.com, *.oaiusercontent.com, api.mapbox.com, events.mapbox.com. | curl -sI https://chatgpt.com`

Hypothesis (E0): realtime streaming, voice mode, collaborative editing
("Pages"/canvas), image delivery, code-interpreter files and maps. Do not use as
a requirement until the UI shows it.

### OBS-004 — Static resources and fonts

`OBS-004 | E4 | 2026-11-17 | App shell | The CSP loads styles/fonts from *.oaistatic.com, cdn.openai.com and fonts.gstatic.com; a Lottie sample and "openai-sans" font data are referenced. | curl -sI https://chatgpt.com`

This suggests animations (Lottie) and custom typography. Do not copy assets.

### OBS-005 — No access to the authenticated UI

`OBS-005 | E0 | 2026-11-17 | All | The browse extension was not connected at start time; authenticated surfaces could not be observed. | browse status`

## Pending observations

| ID | What | Why it matters | Status |
| --- | --- | --- | --- |
| OBS-010 | App shell after login: sidebar, header, composer, thread | Base layout and navigation | open |
| OBS-011 | Empty state/new chat including suggestions and toolbar | Entry point | open |
| OBS-012 | Model and agent selection | Backend mapping | open |
| OBS-013 | Streaming, reasoning, tool calls, stop/retry | Core interaction | open |
| OBS-014 | Markdown, tables, code, formulas, diagrams | Rendering matrix | open |
| OBS-015 | Artifacts and preview panel | largest UI block | open |
| OBS-016 | Image generation and image display | media | open |
| OBS-017 | File/PDF attachments and previews | composer | open |
| OBS-018 | Web search, citations, source cards | research | open |
| OBS-019 | Deep research / agent mode | planning and history | open |
| OBS-020 | Projects, tasks, GPTs/apps | information architecture | open |
| OBS-021 | Settings, connectors, model configuration | auth/config | open |
| OBS-022 | Mobile layout and breakpoints | responsive | open |
| OBS-023 | Keyboard, focus, screen readers, reduced motion | accessibility | open |
| OBS-024 | Error, empty and loading states | completeness | open |
| OBS-025 | Share/export/print | output | open |
