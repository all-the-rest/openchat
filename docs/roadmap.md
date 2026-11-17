# Roadmap

Phases are vertical slices: each ends with something usable and testable.
Function comes first: the reference UI is the model for behavior and measured
defaults, not a pixel target. Visual polish is M6, after the functional
surfaces work.

Tracking: the milestones `v1.0` and `v2.0` on GitHub hold one issue per phase,
one per V2 capability and one release checklist each. Progress is visible at
<https://github.com/all-the-rest/openchat/milestones>.

## M0 — Clean-room analysis

**Goal:** an evidence-backed specification and a feasibility decision.

- Observe the authenticated reference UI (desktop + mobile).
- Fill the surface inventory, rendering matrix and design tokens.
- Derive `docs/spec/**`.
- Confirm the OpenCode integration spike (`@opencode/client`).
- Resolve the open questions in the spec.

**Exit:** no `OPEN:` blocks the first vertical slice; no reference assets in the
repo.

## M1 — Walking skeleton

- Bun workspace, `apps/web`, `apps/server`, `packages/opencode`.
- Auth (`basic` first), same-origin proxy, `/healthz`.
- Session list, new chat, prompt, SSE stream, stop.
- `ChatBackend` fake + fixtures from day one; E2E runs with `BACKEND_MODE=fake`
  and no provider (ADR-0004).
- Plain text transcript with user/assistant messages.
- i18n scaffold (`en`, `de`) from the first component, with a lint gate that
  fails on hard-coded UI strings (ADR-0003) and a language switch persisted in
  `localStorage`.
- Playwright smoke: login → send → receive → stop.

**Exit:** a real prompt streams end to end against a local OpenCode server, the
same flow passes against the fake backend without any provider call, and no
component contains a literal user-visible string.

No visual polish in M1 beyond the measured defaults needed for a usable layout.

## M2 — Rendering core

- Renderer registry and message part model.
- Markdown/GFM, code highlighting, tables, math, Mermaid.
- Reasoning block, tool cards, error cards.
- Auto-scroll, jump-to-latest, copy.
- Fixture-based visual tests.

**Exit:** a rich assistant message renders correctly and safely.

## M3 — Composer and controls

- Attachments (text, image, PDF), drag/drop/paste, limits.
- Model and agent pickers.
- Permission cards (allow once/always/deny).
- Retry, edit, branch, compaction notices.
- Theme tokens and the light/dark switch.

**Exit:** a tool-using agent can run with explicit approvals from the UI.

## M4 — Artifacts and media

- Artifact host on a separate origin and sandboxed iframe.
- Artifact list, viewer, download (read-only in v1).
- Image generation and gallery.
- File/PDF previews.
- Sandbox security tests (cookie theft, fetch, top navigation, self-navigation
  egress).

**Exit:** an agent-generated static HTML artifact renders safely; a generated
image persists.

## M5 — Agents and tasks

- Todos and planning view.
- Subagent parent/child view.
- Scheduled tasks (`/tasks`), pause/resume.
- Worktrees for parallel tasks.
- Browser MCP status and live tool cards.
- Web search citations and source cards.

**Exit:** an agent plans, creates a task, runs it, and the UI shows the whole
lifecycle.

## M6 — Polish

- Command palette, global search.
- PWA shell, offline banner.
- Full accessibility pass (axe, keyboard, screen reader).
- Export/import, usage panel.
- Responsive and mobile polish.

**Exit:** WCAG 2.2 AA pass with no serious findings; mobile core flow works.

## M7 — Deployment

- Docker Compose, Caddy, artifact origin, backups.
- Session auth mode, secrets, rate limits.
- Monitoring and runbook.
- Upgrade and rollback test.
- Successor duties for `opencode-web-gate`: local tunnel mode, shared OpenCode
  service, agent tool runtime, resource guards, update policy, atomic deploy
  ([parity inventory](research/opencode-web-gate-parity.md), issue #20).

**Exit:** a fresh host can be deployed from the docs and restored from backup.

## Deferred / V2

V1 is the chat core only. These are specified but not built in v1:

- **Code surface** — Chat | Code switch and the original OpenCode web UI
  (spec 13, ADR-0005). If embedding is impractical, V2 builds its own.
- **Dictation** — device recording and local STT (FR-34…36).
- **Interactive artifacts** — user input, calculation, present mode, artifact →
  chat bridge (FR-37…40). V1 may ship a read-only artifact viewer, but the
  interactive layer is V2.
- **Multi-source search** — chats, workspace, web providers and apps in one
  query (FR-44…45).
- The reference "Work" surface (excluded by the owner 2026-11-17; chat only).
- Canvas/document editor.
- Maps, rich cards, video.
- Realtime voice mode.
- Multiplayer.
- Multi-user.
