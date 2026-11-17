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

### Chat

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-01 | Create, list, rename, delete and resume chat sessions. | Sessions persist across restarts and are listed by recency. |
| FR-02 | Send a prompt as text with optional attachments, agent and skill references. | Prompt is accepted by OpenCode and appears in the thread. |
| FR-03 | Stream assistant text, reasoning and tool activity live. | Tokens appear incrementally without a full reload. |
| FR-04 | Stop a running response. | Stop ends the stream and leaves a resumable session. |
| FR-05 | Retry, edit and branch a message. | A new branch is created without destroying the old one. |
| FR-06 | Show structured errors and a retry action. | Failed requests are visible and recoverable. |
| FR-07 | Compact long sessions and show the compaction state. | The UI indicates when context was compacted. |

### Rendering

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-08 | Render Markdown, tables, task lists, footnotes and links. | CommonMark/GFM fixtures render correctly. |
| FR-09 | Render code with language label, highlighting and copy. | Code blocks are selectable and copyable. |
| FR-10 | Render inline and block math. | KaTeX fixtures render without raw TeX. |
| FR-11 | Render Mermaid diagrams. | Valid diagrams render; invalid ones show a fallback. |
| FR-12 | Render images, files and PDFs with previews. | Supported types preview; others offer download. |
| FR-13 | Render citations and source cards. | Sources are linked and traceable to the tool call. |
| FR-14 | Render tool calls with status, input, output and errors. | Running/done/error states are distinct. |
| FR-15 | Render reasoning blocks collapsed by default and expanded while streaming. | User can toggle. |
| FR-16 | Render permission and question forms as interactive cards. | Approve/deny/answer round-trips to OpenCode. |
| FR-17 | Render artifacts in a sandboxed panel. | HTML/JS cannot access the app origin or credentials. |

### Agents and tasks

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-18 | Select a primary agent per session and switch it. | Selection persists on the session. |
| FR-19 | Select a model per session. | Selection persists on the session. |
| FR-20 | Show todos and update them live. | Todo changes appear without reload. |
| FR-21 | Show subagent activity and results. | Parent/child relationship is visible. |
| FR-22 | Create, pause, resume and inspect scheduled tasks. | Schedule state survives restart. |
| FR-23 | Show worktrees and allow a task to run in one. | Worktree is selectable and visible. |
| FR-24 | Show MCP servers and their connection status. | Status matches OpenCode. |

### Input and media

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-25 | Attach text, images and PDFs by picker, drag/drop and paste. | Attachments reach OpenCode with correct names. |
| FR-26 | Enforce a 20 MiB per-attachment limit and supported types. | Oversized/unsupported files are rejected with a message. |
| FR-27 | Generate images and show them in a gallery. | Image appears and can be downloaded. |
| FR-28 | Record and play voice if the provider supports it. | Feature hides cleanly when unavailable. |

### Navigation and settings

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-29 | Search chats and jump to a message. | Results are keyboard-navigable. |
| FR-30 | Provide settings for model, agent, language, theme and permissions. | Settings persist. |
| FR-31 | Link to the OpenCode web UI for provider/MCP configuration. | Link opens behind the same auth. |
| FR-32 | Switch UI language between English and German. | All UI strings change without reload. |
| FR-33 | Work on mobile widths and as an installable PWA. | Core chat works at 360 px. |

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

## Open questions

- `OPEN:` Is the reference "Work" mode (header switch) in scope for v1, hidden,
  or a separate later surface? (OBS-013)
- `OPEN:` Is a temporary, non-persisted chat required in v1? (OBS-013)
- `OPEN:` Which image-generation provider/model is available in the owner's
  OpenCode setup?
- `OPEN:` Which voice provider, if any, is available?
- `OPEN:` Should scheduled tasks run while the browser is closed? (OpenCode
  supports it; the UI must show it.)
- `OPEN:` Is a public share link required later, or is export enough?
