# Roadmap

Phases are vertical slices: each ends with something usable and testable.

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
- Plain text transcript with user/assistant messages.
- i18n scaffold (`en`, `de`) from the first component, with a lint gate that
  fails on hard-coded UI strings (ADR-0003).
- Playwright smoke: login → send → receive → stop.

**Exit:** a real prompt streams end to end against a local OpenCode server, and
no component contains a literal user-visible string.

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
- Artifact list, viewer, download.
- Image generation and gallery.
- File/PDF previews.
- Sandbox security tests (cookie theft, fetch, top navigation).

**Exit:** an agent-generated HTML artifact renders safely; a generated image
persists.

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

**Exit:** a fresh host can be deployed from the docs and restored from backup.

## Deferred

- The reference "Work" surface (excluded by the owner 2026-11-17; chat only).
- Canvas/document editor.
- Interactive apps/widgets.
- Maps, rich cards, video.
- Voice mode.
- Multiplayer.
- Multi-user.
