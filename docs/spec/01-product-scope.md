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
- One front door for both surfaces: our chat and the original OpenCode
  workspace UI, switchable in the app.
- Search across several sources (web providers, workspace, chats, connected
  apps) from one place.
- Safe by default: one password, authenticated OpenCode, sandboxed artifacts.

## v1 scope

V1 is the chat core: sessions, streaming, stop, model/agent selection,
permissions and forms, rendering, attachments, images, static artifacts, auth
and i18n. It is deliberately small. The Code surface, dictation, interactive
artifacts and multi-source search are **V2**; they are specified here so they
are not lost, but they do not block v1.

## Functional requirements

Evidence column:

- `OBS-NNN` — behaviour or layout recorded in the reference.
- `—` — no reference observation. The row is a product decision or follows from
  the OpenCode API (architecture 02), not a claim about the reference; it may be
  built. The observer can still add evidence later.
- `— (OBS-NNN pending)` — the row depends on a probe that has not happened. It
  is specified so the scope is complete, but it must not be built until the
  probe is recorded or the owner confirms the behaviour.

M1 contains only rows with evidence, an architecture decision or an owner
decision.

### Chat

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-01 | Create, list, rename, delete and resume chat sessions. | Sessions persist across restarts and are listed by recency. | OBS-011, OBS-029, OBS-030 |
| FR-02 | Send a prompt as text with optional attachments, agent and skill references. | Prompt is accepted by OpenCode and appears in the thread. | OBS-012, OBS-015 |
| FR-03 | Stream assistant text, reasoning and tool activity live. | Tokens appear incrementally without a full reload. | OBS-015 |
| FR-04 | Stop a running response. | Stop ends the stream and leaves a resumable session. | OBS-015 |
| FR-05 | Retry, edit and branch a message. | A new branch is created without destroying the old one. | OBS-017 (edit action), OBS-032 pending |
| FR-06 | Show structured errors and a retry action. | Failed requests are visible and recoverable. | — |
| FR-07 | Compact long sessions and show the compaction state. | The UI indicates when context was compacted. | — |

### Rendering

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-08 | Render Markdown, tables, task lists, footnotes and links. | CommonMark/GFM fixtures render correctly. | OBS-016 (tables; task lists/footnotes target) |
| FR-09 | Render code with language label, highlighting and copy. | Code blocks are selectable and copyable. | OBS-016 |
| FR-10 | Render inline and block math. | KaTeX fixtures render without raw TeX. | OBS-016 (inline); OBS-033 pending |
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

Realtime voice mode is out of scope for v1 and V2; dictation (FR-34) is the
voice feature. Read-aloud appears only if a provider returns audio.

### Voice input (dictation) — V2

Dictation is an input method, not a spoken conversation. It is distinct from
realtime voice mode, which stays out of scope.

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-34 | Record audio on the device and transcribe it into the composer. The transcript is editable text and is **never** sent automatically. | Recording works with the microphone permission granted per use; the transcript lands in the draft; cancel discards audio and text. | OBS-012 (control only) |
| FR-35 | Support push-to-talk and a hands-free toggle with a visible level meter, elapsed time and a hard duration limit. | The state is unambiguous, keyboard-operable and cancellable with `Escape`. | — |
| FR-36 | Transcribe through an owner-configured speech-to-text service (local Whisper-compatible sidecar by default), with language hint and explicit error states. | Disabled cleanly when no STT service is configured; the UI never calls a third-party STT silently. | — |

### Interactive artifacts — V2

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-37 | Run interactive HTML/CSS/JS artifacts in the sandbox: user input, calculation, charts, simulations and small tools. | A calculator and a chart fixture accept input and recompute without a page reload. | — (OBS-020 pending) |
| FR-38 | Provide reset, fullscreen/present and download for an interactive artifact. | Reset restores the initial state; present mode removes app chrome; download returns the source. | — |
| FR-39 | Let an artifact submit a result back to the chat through a narrow, validated `postMessage` bridge. | A fixture artifact posts a JSON result; the UI shows it as a draft or message; messages from a different frame, or with a wrong nonce or shape, are rejected. | — |
| FR-40 | Interactive artifacts work offline: no network, no CDN, no cookies, no access to the app origin or session. | The sandbox never resolves an external URL and `fetch` fails. | NFR-06 |

### Surfaces, remote host and search — V2 (proposed 2026-11-17)

These are recorded requirements from the owner for version 2, not v1. If
embedding OpenCode's own UI turns out to be impractical, V2 builds an
equivalent Code surface ourselves.

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-41 | A top-left surface switch toggles **Chat** (our UI) and **Code** (the original OpenCode web UI of the same server). The choice persists per owner and has a keyboard shortcut. | Switching keeps state; the active surface is obvious; no Chat/Work switch exists. | OBS-010 (position only) |
| FR-42 | Render the original OpenCode web UI in the Code surface, authenticated by the app, without publishing OpenCode unauthenticated. | The embedded UI loads, navigates and streams; its cookies stay on its own host; a fallback opens it in a new tab. | — |
| FR-43 | Run the app against a remote OpenCode host so chats, workspace and configuration live on that machine. | Pointing `OPENCODE_URL` at the remote host works end to end over the private network or an authenticated tunnel. | — |
| FR-44 | Search across multiple sources in one query: web providers (Exa, Firecrawl, custom), workspace files, chat history and connected apps; dedupe, rank and label each result with its source. | One query returns grouped, cited results; each group can be disabled; no source is queried silently. | — |
| FR-45 | Search and manage apps/connectors: list MCP servers, tools and skills, show status, connect/disconnect, and run a tool from the result. | Search finds a connected app and its tools; status matches OpenCode; actions are permission-gated. | — |

The Code surface is OpenCode's own UI, not the reference product's. It is
embedded because the owner wants one front door, not because it is rebuilt.

### Navigation and settings

| ID | Requirement | Acceptance | Evidence |
| --- | --- | --- | --- |
| FR-29 | Search chats and jump to a message. | Results are keyboard-navigable. | OBS-011 (control only) |
| FR-30 | Provide settings for model, agent, language, theme and permissions. | Settings persist. | OBS-014, OBS-037 |
| FR-31 | Show the OpenCode configuration path and, when `ADMIN_PROXY=on`, a same-origin `/admin/opencode` link behind the session. OpenCode is never published. | The link is hidden when the proxy is off; no OpenCode port is reachable from outside. | ADR-0002 |
| FR-32 | Switch UI language between English and German. | All UI strings change without reload. | OBS-010 (German UI) |
| FR-33 | Work on mobile widths, with the core chat flow usable at 390 px and responsive down to 360 px. | Core chat works at 390 px; no horizontal scroll at 360 px. | OBS-028 |

## Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-01 | Single-user auth; no public signup. Password from environment or hash. |
| NFR-02 | OpenCode is never reachable unauthenticated. It is internal-only, or served behind the app's auth as the Code surface. |
| NFR-03 | All secrets stay server-side; the browser holds only a session cookie. |
| NFR-04 | First contentful paint < 2 s on a local network; stream first token < 1 s after provider start. |
| NFR-05 | WCAG 2.2 AA for keyboard, focus, contrast and labels. |
| NFR-06 | Artifacts run on a separate origin or in a sandbox without same-origin access. |
| NFR-07 | No personal data in logs; prompts and attachments are not logged by default. |
| NFR-08 | Backups cover OpenCode data, workspace and configuration. |
| NFR-09 | UI strings are fully externalized (i18n en/de). |
| NFR-10 | Every backend call has a timeout, cancellation and a user-visible error. |
| NFR-11 | Automated tests never call a real provider. A deterministic fake backend and fake model serve unit, integration and E2E tests; live smoke tests are opt-in, capped and excluded from CI. |
| NFR-12 | A developer can run the whole product against the fake backend without spending provider quota. |
| NFR-13 | Recorded audio is processed for transcription only and is not persisted by the app unless the owner explicitly keeps it. |
| NFR-14 | Interactive artifacts are deterministic, offline and sandboxed; their bridge to the app is allowlisted and schema-validated. |

## Out of scope for v1

- Multi-user, teams, roles, sharing.
- Billing, plans, quotas — unless the owner connects a metered provider; the app
  itself never sells or meters access.
- Public chat sharing and SEO pages.
- Native mobile apps.
- Model training or fine-tuning.
- Importing ChatGPT account data.
- Cloning OpenAI-specific backend behavior or internal APIs.
- Account, billing and plan management, parental controls, trust contacts,
  usage quotas and marketing preferences. They presuppose a hosted multi-tenant
  account that this single-user self-hosted product does not have.
- Realtime spoken conversation ("voice mode"). Device-side dictation is in
  scope (FR-34…36); a duplex voice session is not.
- Public sharing of the Code surface. It is always behind the owner's auth.
- The reference **Work** surface. The owner excluded it: v1 is chat only, and
  no Chat/Work switch is rendered. The observation of the switch (OBS-013)
  stays in the log as context, not as a requirement. (2026-11-17)

## Open questions

- `OPEN:` Is a temporary, non-persisted chat required in v1? (OBS-013)
- `OPEN:` Which image-generation provider/model is available in the owner's
  OpenCode setup?
- `OPEN:` Which STT service will run locally (Whisper.cpp server, faster-whisper,
  or an OpenAI-compatible endpoint), and on which device?
- `OPEN:` Should scheduled tasks run while the browser is closed? (OpenCode
  supports it; the UI must show it.)
- `OPEN:` Is a public share link required later, or is export enough?
