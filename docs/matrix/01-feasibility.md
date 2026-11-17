# 01 — Feasibility Matrix

What a self-hosted, single-user chat UI can do with OpenCode as the backend and
an SDK integration. Based on the OpenCode 2.3.0 OpenAPI and docs; see
[`../research/opencode-capabilities.md`](../research/opencode-capabilities.md).

## Legend

| Symbol | Meaning |
| --- | --- |
| ✅ | native in OpenCode; UI work only |
| 🟡 | possible with custom UI, glue or an MCP/tool |
| 🔴 | not available or out of scope |
| ❓ | needs a spike before committing |

Effort: **S** ≤ 1 day, **M** 2–5 days, **L** 1–2 weeks, **XL** > 2 weeks.

## A. Chat and models

| Capability | Reference | Self-hosted + OpenCode | SDK | Effort | v1 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Streaming text | ✅ | ✅ `session.text.delta` | ✅ | S | yes | SSE fan-out from BFF |
| Reasoning stream | ✅ | ✅ `session.reasoning.delta` | ✅ | S | yes | Collapsible block |
| Tool calls | ✅ | ✅ assistant tool parts + events | ✅ | M | yes | Status cards |
| Stop/interrupt | ✅ | ✅ `session.interrupt` | ✅ | S | yes | Keep partial answer |
| Retry/fork/revert | ✅ | ✅ `session.fork`, `revert.*` | ✅ | M | yes | Branch UI |
| Compaction | ✅ | ✅ `session.compact` + events | ✅ | S | yes | Show boundary |
| Model switch | ✅ | ✅ `session.switchModel` | ✅ | S | yes | Per session |
| Agent switch | ✅ | ✅ `session.switchAgent` | ✅ | S | yes | Per session |
| Session persistence | ✅ | ✅ OpenCode store | ✅ | S | yes | |
| Prompt queue | ✅ | ✅ `session.inbox.list/cancel/update` | ✅ | S | yes | `delivery: "queue"`; returned inbox entry |
| Session search | ✅ | 🟡 list + client index | 🟡 | M | later | Full-text index if needed |
| Parallel sessions | ✅ | ✅ | ✅ | M | yes | One active run per session |
| Background jobs | ✅ | ✅ `session.background()`, `experimental.job.list()` | ✅ | M | later | `JobShell \| JobSubagent \| JobImage` |
| Scheduled tasks | ✅ | ✅ `experimental.schedule.*` | ✅ | M | later | Runs server-side |
| Multi-user | — | 🔴 | 🔴 | XL | no | Out of scope |

## B. Rendering

| Capability | Reference | Self-hosted + OpenCode | SDK | Effort | v1 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Markdown/GFM | ✅ | ✅ text parts | ✅ | S | yes | Custom renderer |
| Code + highlighting | ✅ | ✅ text parts | ✅ | S | yes | Shiki |
| Tables/task lists/footnotes | ✅ | ✅ text parts | ✅ | S | yes | GFM |
| LaTeX | ✅ | ✅ text parts | ✅ | S | yes | KaTeX |
| Mermaid | ✅ | ✅ text parts | ✅ | M | yes | Sanitize |
| Images in/out | ✅ | ✅ attachments; ✅ image gen | ✅ | M | yes | Model capability |
| Files/PDF | ✅ | ✅ attachments | ✅ | M | yes | 20 MiB limit |
| Artifacts | ✅ | ✅ `experimental.artifacts.*` | ✅ | L | yes | Storage API included; needs sandbox host |
| Charts | ✅ | 🟡 via code/artifact | 🟡 | M | yes | Render generated files |
| Citations/sources | ✅ | 🟡 websearch output + UI | 🟡 | M | yes | Tool output schema |
| Canvas/document editor | ✅ | 🟡 file editing + artifacts | 🟡 | L | later | |
| Interactive artifacts/widgets | ✅ | ✅ `experimental.artifacts.*` + `allow-scripts` | ✅ | L | v2 | Priority feature; sandbox + bridge |
| Multi-source search | ✅ | 🟡 `websearch.*` + files + chat index + MCP | 🟡 | L | v2 | Dedupe, rank, cite |
| App/connector search | ✅ | 🟡 `mcp.*`, `integration.*` | 🟡 | M | v2 | Status + connect |
| Interactive apps | ✅ | 🟡 MCP + custom renderers | 🟡 | L | later | |
| Maps/places | ✅ | 🟡 MCP/embed | 🟡 | M | later | |
| Rich cards | ✅ | 🟡 custom card registry | 🟡 | L | later | |
| Video | ✅ | 🟡 MCP/embed | 🟡 | L | later | |
| Voice mode (realtime) | ✅ | 🟡 `voice.models/session` | 🟡 | M | no (v2+) | Provider dependent; not dictation |
| Dictation (device STT) | ✅ | 🟡 browser capture + Whisper sidecar | 🟡 | M | v2 | No provider quota with local STT |
| Image generation | ✅ | ✅ `experimental.generate.image` | ✅ | M | yes | Provider dependent |
| Multiplayer | ✅ | 🔴 | 🔴 | XL | no | |

## C. Tools and agents

| Capability | Reference | Self-hosted + OpenCode | SDK | Effort | v1 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Shell execution | ✅ | ✅ built-in shell tool | ✅ | S | yes | Permission-gated |
| File read/write | ✅ | ✅ built-in tools | ✅ | S | yes | Workspace scoped |
| Browser automation | ✅ | ✅ via `browse` MCP | ✅ | M | yes | Extension/relay |
| Web search | ✅ | ✅ `websearch.query` | ✅ | S | yes | Provider config; agent tool |
| MCP servers | ✅ | ✅ `mcp.servers` | ✅ | S | yes | Status UI |
| Subagents | ✅ | ✅ built-in | ✅ | M | yes | Parent/child view |
| Todos/planning | ✅ | ❓ no todo method or event in 2.3.0 | ❓ | M | spike | Needs a data source |
| Worktrees | — | ✅ worktree API | ✅ | M | later | Parallel tasks |
| Permissions | ✅ | ✅ `permission.asked/replied` | ✅ | M | yes | Blocking cards |
| Forms/questions | ✅ | ✅ `session.form.*` | ✅ | M | yes | Interactive cards |
| Skills | ✅ | ✅ skill attachments | ✅ | S | yes | Selector |
| Plugins | — | ✅ plugin API | ✅ | M | later | Custom tools |
| Terminal/PTY | ✅ | ✅ PTY + shell | ✅ | M | later | Terminal component |
| LSP/diagnostics | — | ✅ built-in | ✅ | S | later | Tool output |

## D. Platform

| Capability | Reference | Self-hosted + OpenCode | SDK | Effort | v1 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Single-user auth | ✅ | 🟡 custom BFF | 🟡 | S | yes | Basic or session |
| Provider config | ✅ | ✅ OpenCode config, Code surface (V2) or admin proxy | 🟡 | S | yes | Never publish OpenCode unauthenticated |
| Code surface (original OpenCode UI) | ✅ | ✅ iframe on dedicated authenticated origin | 🟡 | M | v2 | Fallback: build our own |
| Model list/capabilities | ✅ | ✅ `model.list`, `provider.list` | ✅ | S | yes | |
| Usage/cost | ✅ | ✅ `experimental.usage.limits`, `session.stats` | ✅ | M | later | |
| Export/import | ✅ | ✅ `session.export/import` | ✅ | S | yes | JSON/Markdown |
| PWA/offline shell | ✅ | 🟡 custom | 🟡 | M | later | Shell cache only |
| i18n en/de | ✅ | 🟡 custom | 🟡 | S | yes | Externalized strings |
| Themes | ✅ | 🟡 custom | 🟡 | S | yes | Tokens |
| Accessibility | ✅ | 🟡 custom | 🟡 | M | yes | WCAG 2.2 AA |
| Observability | — | 🟡 custom | 🟡 | S | later | Logs/metrics |
| Backups | — | 🟡 ops | 🟡 | S | yes | Documented |

## E. SDK integration specifics

| Topic | Assessment |
| --- | --- |
| `@opencode/sdk` embedded host | 🟡 compiles and exposes the contract in theory; no spike recorded yet |
| Custom agents/tools via plugins | ✅ `OpenCode.create({ plugins })` |
| Official web UI in embedded mode | 🔴 none; V2 embeds it from a separate server via the Code host |
| Lifecycle/cleanup | 🟡 `await using` / `close()`; needs care |
| Version coupling | 🟡 pin the SDK; test upgrades |
| Streaming | ✅ `events.subscribe()` |
| Deployment | 🟡 single Bun process; no separate OpenCode container |
| Fake backend / zero-quota E2E | ✅ in-memory `ChatBackend`, scripted envelope; ADR-0004 |

## Recommended v1 cut

Ship these first:

1. Auth (basic), session list, new chat, prompt, streaming, stop.
2. Fake backend + fixtures; the E2E suite never calls a provider.
3. Markdown, code, tables, math, Mermaid, reasoning, tool cards.
4. Model/agent picker, attachments, permissions.
5. Static artifact viewer in the sandbox + image generation.
6. i18n en/de, dark/light, responsive.

Defer to V2: Code surface, dictation, interactive artifacts, multi-source and
app search. Defer further: canvas, maps, rich cards, realtime voice, video,
multiplayer, terminal, plugins, scheduled tasks (unless the first use case needs
them).

## Not worth building

- A custom model gateway. OpenCode already owns providers.
- A custom MCP client. OpenCode owns MCP.
- A custom permission engine. OpenCode owns rules.
- A custom artifact compiler. Use the artifact provider and sandbox.
- A multi-user auth system for a single-user prototype.
