# 01 — Product Scope

## Persona

One technical owner. The owner runs the app on their own machine or VPS, owns
the models and tools, and is the only user. There is no signup, no team, no
billing and no public sharing in v1.

## Goals

- A polished, fast, keyboard-friendly chat interface.
- All model calls go to a self-hosted or owner-controlled provider through
  OpenCode.
- Agents can act: read/write files, run commands, browse, plan and create tasks.
- The UI makes agent activity and permissions visible and interruptible.
- Rich output: Markdown, code, tables, math, diagrams, artifacts, images, files.
- Safe by default: one password, internal OpenCode, sandboxed artifacts.

## Functional requirements

Evidence column: `OBS-NNN` is a recorded observation. `—` marks a target
requirement that has **no reference evidence yet**; it is a product decision,
listed so the scope is complete, and must not be built before the observer
records it or the owner confirms it. M1 contains only rows with evidence or an
architecture decision.

### Chat

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-01 | Create, list, rename, delete and resume chat sessions. | Sessions persist across restarts and are listed by recency. | OBS-011, OBS-029, OBS-030 |
| FR-02 | Send a prompt as text with optional attachments, agent and skill references. | Prompt is accepted by OpenCode and appears in the thread. | OBS-012, OBS-015 |
| FR-03 | Stream assistant text, reasoning and tool activity live. | Tokens appear incrementally without a full reload. | OBS-015 |
| FR-04 | Stop a running response. | Stop ends the stream and leaves a resumable session. | OBS-015 |
| FR-05 | Retry, edit and branch a message. | A new branch is created without destroying the old one. | OBS-017 (edit action), OBS-032 |
| FR-06 | Show structured errors and a retry action. | Failed requests are visible and recoverable. | — (OBS-030 pending) |
| FR-07 | Compact long sessions and show the compaction state. | The UI indicates when context was compacted. | — |

### Rendering

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-08 | Render Markdown, tables, task lists, footnotes and links. | CommonMark/GFM fixtures render correctly. | OBS-016 |
| FR-09 | Render code with language label, highlighting and copy. | Code blocks are selectable and copyable. | OBS-016 |
| FR-10 | Render inline and block math. | KaTeX fixtures render without raw TeX. | OBS-016, OBS-033 |
| FR-11 | Render Mermaid diagrams. | Valid diagrams render; invalid ones show a fallback. | OBS-016 |
| FR-12 | Render images, files and PDFs with previews. | Supported types preview; others offer download. | — (OBS-022 pending) |
| FR-13 | Render citations and source cards. | Sources are linked and traceable to the tool call. | — (OBS-023 pending) |
| FR-14 | Render tool calls with status, input, output and errors. | Running/done/error states are distinct. | — |
| FR-15 | Render reasoning blocks collapsed by default and expanded while streaming. | User can toggle. | OBS-015 (status only) |
| FR-16 | Render permission and question forms as interactive cards. | Approve/deny/answer round-trips to OpenCode. | — |
| FR-17 | Render artifacts in a sandboxed panel. | HTML/JS cannot access the app origin or credentials. | — (OBS-020 pending) |

### Agents and tasks

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-18 | Select a primary agent per session and switch it. | Selection persists on the session. | — |
| FR-19 | Select a model per session. | Selection persists on the session. | OBS-014 |
| FR-20 | Show todos and update them live — **spike**: 2.3.0 exposes no todo endpoint/event; verify `experimental.todo` first. | Todo changes appear without reload, or the view is not shipped. | — (spike) |
| FR-21 | Show subagent activity and results. | Parent/child relationship is visible. | — |
| FR-22 | Create, pause, resume and inspect scheduled tasks. | Schedule state survives restart. | — |
| FR-23 | Show worktrees and allow a task to run in one. | Worktree is selectable and visible. | — |
| FR-24 | Show MCP servers and their connection status. | Status matches OpenCode. | — |

### Input and media

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-25 | Attach text, images and PDFs by picker, drag/drop and paste. | Attachments reach OpenCode with correct names. | OBS-012 (control only) |
| FR-26 | Enforce a 20 MiB per-attachment limit and supported types. | Oversized/unsupported files are rejected with a message. | — |
| FR-27 | Generate images and show them in a gallery. | Image appears and can be downloaded. | — (OBS-021 pending) |
| FR-28 | Record and play voice if the provider supports it. | Feature hides cleanly when unavailable. | OBS-012 (control only) |

### Navigation and settings

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-29 | Search chats and jump to a message. | Results are keyboard-navigable. | OBS-011 (control only) |
| FR-30 | Provide settings for model, agent, language, theme and permissions. | Settings persist. | OBS-014, OBS-029 (partial) |
| FR-31 | Show the OpenCode configuration path and, when `ADMIN_PROXY=on`, a same-origin `/admin/opencode` link behind the session. OpenCode is never published. | The link is hidden when the proxy is off; no OpenCode port is reachable from outside. | ADR-0002 |
| FR-32 | Switch UI language between English and German. | All UI strings change without reload. | OBS-010 (German UI) |
| FR-33 | Work on mobile widths and as an installable PWA. | Core chat works at 360 px. | OBS-028 |

## Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-01 | Single-user auth; no public signup. Password from environment or hash. |
| NFR-02 | OpenCode is never exposed directly to the public internet. |
| NFR-03 | All secrets stay server-side; the browser holds only a session cookie. |
| NFR-04 | First contentful paint < 2 s on a local network; stream first token < 1 s after provider start. |
| NFR-05 | WCAG 2.2 AA for keyboard, focus, contrast and labels. |
| NFR-06 | Artifacts run on a separate origin or in a sandbox without same-origin access. |
| NFR-07 | No personal data in logs; prompts and attachments are not logged by default. |
| NFR-08 | Backups cover OpenCode data, workspace and configuration. |
| NFR-09 | UI strings are fully externalized (i18n en/de). |
| NFR-10 | Every backend call has a timeout, cancellation and a user-visible error. |

## Out of scope for v1

- Multi-user, teams, roles, sharing.
- Billing, plans, quotas.
- Public chat sharing and SEO pages.
- Native mobile apps.
- Model training or fine-tuning.
- Importing ChatGPT account data.
- Cloning OpenAI-specific backend behavior or internal APIs.
- Account, billing and plan management, parental controls, trust contacts,
  usage quotas and marketing preferences. They presuppose a hosted multi-tenant
  account that this single-user self-hosted product does not have.
- The reference **Work** surface. The owner excluded it: v1 is chat only, and
  no Chat/Work switch is rendered. The observation of the switch (OBS-013)
  stays in the log as context, not as a requirement. (2026-11-17)

## Open questions

- `OPEN:` Is a temporary, non-persisted chat required in v1? (OBS-013)
- `OPEN:` Which image-generation provider/model is available in the owner's
  OpenCode setup?
- `OPEN:` Which voice provider, if any, is available?
- `OPEN:` Should scheduled tasks run while the browser is closed? (OpenCode
  supports it; the UI must show it.)
- `OPEN:` Is a public share link required later, or is export enough?
