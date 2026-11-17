# 03 — Rendering Matrix

What the reference UI can display graphically, how it is evidenced, and what it
means for our implementation.

**Status:** candidate checklist. Rows marked `hypothesis` come from public
metadata or general knowledge and must be verified in the authenticated UI
before they become requirements.

## Evidence and status

| Status | Meaning |
| --- | --- |
| `observed` | seen in the UI or in public metadata with an evidence ID |
| `hypothesis` | plausible, not yet verified |
| `open` | unknown, needs a dedicated probe |
| `absent` | checked and not present |
| `planned (V2)` | owner-requested, specified outside v1 |

## A. Text and structure

| ID | Capability | Reference evidence | Status | Source in OpenCode | Frontend work | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Markdown paragraphs, emphasis, links | OBS-016 | observed | assistant text parts | Markdown renderer | S |
| R-02 | Headings, lists, blockquotes, rules | OBS-016 | observed | assistant text parts | Markdown renderer | S |
| R-03 | Tables | OBS-016 | observed | assistant text parts | GFM tables | S |
| R-04 | Task lists and footnotes | — | open | assistant text parts | GFM + footnote plugin | S |
| R-05 | Inline code and code blocks | OBS-016 | observed | assistant text parts | Shiki/Prism | S |
| R-06 | Syntax highlighting and copy button | OBS-016 | observed | assistant text parts | highlighter + clipboard | S |
| R-07 | Diff view | — | open | tool output, session diff | diff renderer | M |
| R-08 | Inline and block LaTeX | OBS-016 (inline only), OBS-033 | partial | assistant text parts | KaTeX | S |
| R-09 | Mermaid diagrams | OBS-016 | observed | assistant text parts | Mermaid + sanitizer | M |
| R-10 | Other diagram syntaxes (Graphviz, PlantUML) | — | open | assistant text parts | optional renderer | M |

## B. Media

| ID | Capability | Reference evidence | Status | Source in OpenCode | Frontend work | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| R-11 | Uploaded images inline | — | hypothesis | prompt file attachments (PNG/JPEG/GIF/WebP) | image component + lightbox | S |
| R-12 | Generated image grid | — | hypothesis | `experimental/generate/image`, media endpoint | gallery + lightbox | M |
| R-13 | Image editing/inpainting | — | open | model/tool dependent | editor | L |
| R-14 | Video generation/playback | CSP: youtube/vimeo embeds | hypothesis | tool/MCP dependent | video player | L |
| R-15 | Audio playback and voice waveform | CSP: realtime WebSocket | hypothesis | `experimental/voice/*` | audio component | M |
| R-16 | PDF preview | — | hypothesis | prompt PDF attachment | PDF viewer | M |
| R-17 | File cards, upload progress, download | — | hypothesis | prompt attachments, `experimental/media` | file card | S |
| R-18 | Code-interpreter files and downloads | CSP: `checkpoints-*.files.openai.com` | hypothesis | shell/PTY, `experimental/artifacts` | file list | M |

## C. Research and sources

| ID | Capability | Reference evidence | Status | Source in OpenCode | Frontend work | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| R-19 | Inline citation chips | — | hypothesis | websearch tool output | citation renderer | M |
| R-20 | Source cards with favicon and snippet | — | hypothesis | websearch tool output | source list | M |
| R-21 | Search progress and query list | — | hypothesis | tool state events | progress component | M |
| R-22 | Deep-research plan and timeline | — | hypothesis | subagents + tools + todos | timeline | L |
| R-23 | Footnote/source appendix | — | hypothesis | assistant text + tool output | Markdown extension | S |

## D. Artifacts and apps

| ID | Capability | Reference evidence | Status | Source in OpenCode | Frontend work | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| R-24 | HTML/CSS/JS artifact preview | CSP: `*.web-sandbox.oaiusercontent.com` | hypothesis | `experimental/artifacts` (provider, entry, url) | sandboxed iframe | L |
| R-25 | React/JSX artifact preview | CSP: sandbox origin | hypothesis | artifact provider | build/runtime sandbox | L |
| R-26 | SVG/diagram artifact | CSP: sandbox origin | hypothesis | artifact provider | sanitized inline/SVG frame | M |
| R-27 | Artifact side panel, versioning, copy/download | — | hypothesis | artifact API + session files | panel + history | L |
| R-28 | Charts from code execution | — | hypothesis | shell/PTY + artifact files | chart renderer or image | M |
| R-29 | Data tables with download | — | hypothesis | artifact files | table + CSV download | M |
| R-30 | Canvas/document editor | CSP: `pages-realtime` | hypothesis | file editing + artifacts | editor | L |
| R-31 | Interactive apps/widgets | indirect: CSP allows `*.chatgpt.site`, `*.embed.chatgpt.site` | planned (V2) | artifact provider + `allow-scripts` + bridge | widget host | L |
| R-32 | Maps and places | CSP: Google Maps, MapKit, Mapbox | hypothesis | tool/MCP output | map embed | M |
| R-33 | Rich cards (weather, stocks, shopping, recipes) | — | open | tool/MCP output + JSON schema | card registry | L |
| R-34 | Embedded third-party content (YouTube, Vimeo, CodePen, Google Docs) | CSP frame-src | hypothesis | tool output | embed allowlist | M |
| R-35 | Collaborative/multiplayer cursors | CSP: `multiplayer-u0` | hypothesis | not in scope for v1 | — | L |

## E. Agent activity

| ID | Capability | Reference evidence | Status | Source in OpenCode | Frontend work | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| R-36 | Reasoning/thinking block | OBS-015 (status only) | partial | assistant reasoning parts + `session.reasoning.delta` | collapsible block | S |
| R-37 | Tool-call card (running/done/error) | — | hypothesis | assistant tool parts + tool state events | tool card | M |
| R-38 | Permission request card | — | hypothesis | `permission.asked`, `permission.replied` | approve/deny UI | M |
| R-39 | Interactive question/form card | — | hypothesis | `session.form.*`, `form.replied` | form renderer | M |
| R-40 | Task/todo list | — | open | `experimental.todo` (unverified) | checklist + spike | M |
| R-41 | Agent/browser live view | — | hypothesis | browse MCP screenshots/events | live panel | L |
| R-42 | Step log and progress timeline | — | hypothesis | tool events + todos | timeline | M |
| R-43 | Terminal/shell output | — | hypothesis | `session.shell`, PTY, `experimental.persistentPty` | terminal component | M |
| R-44 | Scheduled task status | — | hypothesis | `experimental/schedule/*` | task list | M |

## F. Message actions and output

| ID | Capability | Reference evidence | Status | Source in OpenCode | Frontend work | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| R-45 | Copy, regenerate, edit, branch | OBS-017 (copy/copy prompt/edit) | partial | `session.prompt`, `session.fork`, `session.revert` | actions + branch UI | M |
| R-46 | Share/export/print | — | hypothesis | `experimental.session.export/import` | export dialog | M |
| R-47 | Suggestion chips and follow-ups | OBS-012, OBS-019 | partial | UI-only | chips | S |
| R-48 | Emoji and Lottie animations | OBS-004 (Lottie sample referenced); emoji font not measured | hypothesis | UI-only | emoji + optional Lottie | S |
| R-49 | Streaming cursor and stop button | OBS-015 | observed | `session.interrupt`, delta events | stream state | S |
| R-50 | Error, retry and rate-limit states | — | hypothesis | structured errors, retry parts | error card | M |

## Immediate consequence

The hard part is not the chat transcript. It is the **rendering registry**:
a small, typed set of renderers for text, code, math, diagrams, images, files,
sources, tool calls, forms, permissions, artifacts and terminal output. Build
that registry early; every backend feature plugs into it.

The sandboxed artifact host is the highest-risk component and needs its own ADR
([`docs/architecture/04-artifact-sandbox.md`](../architecture/04-artifact-sandbox.md)).
