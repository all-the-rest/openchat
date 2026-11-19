# 06 — Agents and Tasks

## Agents

- List agents from `agent.list()`.
- Show name, description, mode (primary/subagent) and model.
- Select a primary agent per session.
- Subagents are started by the primary agent through the subagent tool; the UI
  shows parent/child sessions and their status.
- The UI never silently changes the agent.

## Planning and todos

**Spike required.** The 2.3.0 OpenAPI has no todo endpoint and the event union
has no todo event; only an `experimental.todo` config flag is known. Until a
spike proves a data source:

- Do not promise a live todo panel.
- If the agent emits a plan as a tool call or text, render it as a normal tool
  card or Markdown list.
- If a todo store exists, poll it behind the spike flag rather than inventing
  events.

The rest of this section describes the target once the spike succeeds.

- Render todos as a checklist with status: pending, in progress, completed,
  cancelled.
- Update from events or a scoped subscription; do not poll the whole workspace.
- A todo list belongs to a session, not to the global task board.

## Task board

The global `/tasks` route combines:

1. **Scheduled tasks** — OpenCode schedules (`experimental.schedule.*`).
2. **Background jobs** — long-running sessions/subagents.
3. **Todo summaries** — sessions with open todos.

Each task shows:

- title, source (schedule/session), status, next run, last run,
- link to the session,
- pause/resume/cancel actions where supported.

## Scheduling

- Create: title, prompt, location/project, agent/model, schedule (once,
  interval, cron if supported).
- Pause and resume without deleting history.
- The UI must state clearly that scheduled tasks run on the server even when the
  browser is closed.
- A failed run keeps its error and does not silently retry forever.

## Worktrees

- v1 runs in a single `WORKSPACE_DIR`; worktree management is a later surface
  because it needs a project/repository selection first.
- List worktrees (`worktree.list()`).
- Create (`worktree.create()`) for a task; show its directory and branch.
- Remove (`worktree.remove()`) requires confirmation and must refuse if
  uncommitted changes exist, unless the owner explicitly forces it.
- Parallel tasks should use separate worktrees to avoid file conflicts.

## Permissions

- Show pending permission requests prominently.
- Explain the action, resource and scope.
- Offer allow once, always allow, deny.
- "Always allow" writes a rule and shows the exact rule.
- Never auto-approve destructive shell commands by default.

## Browser tools

- The `browse` MCP server can expose browser tools to agents.
- Show when a browser tool is running and which URL it is on.
- If the tool produces screenshots, show them in the tool card.
- The user can stop the run at any time.
- The browser session belongs to the owner; the UI must not expose it to other
  users (single-user anyway).

## Memory

Persistent, agent-managed memory across sessions. See
[`docs/decisions/0008-agent-memory.md`](../decisions/0008-agent-memory.md) and
[`docs/architecture/08-memory.md`](../architecture/08-memory.md).

- **Store:** `MEMORY_DATA_DIR` (default `/workspace/.memory`) holds `facts.jsonl`
  (one atomic fact per line, append-only), `INDEX.md` (the push layer) and
  `audit.jsonl` (every mutation). Directory `0700`, files `0600`. The BFF is the
  only writer; `memory-data` is read-write in the BFF only and the MCP server
  writes through it.
- **Record shape:** each fact has a kind (`preference`, `profile`, `project`,
  `decision`, `episode`, `snippet`), trust (`explicit`, `observed`, `inferred`),
  status (`active`, `superseded`, `expired`, `deleted`), provenance, timestamps
  and a checksum — not just a string.
- **Batch MCP tools:** `mem_index`, `mem_find`, `mem_get`, `mem_write`,
  `mem_update`, `mem_delete`, `mem_prune`, `mem_stats`. All calls go through the
  BFF's `POST /internal/memory` with the shared internal token; thin client, no
  direct file writes, no read-the-whole-store tool. Search before write; reject
  secrets and instruction-like payloads.
- **Injected index:** on session creation the BFF pushes one bounded
  `memory.index` entry via `experimental.session.instructions.entry.put` (value
  = `INDEX.md`, ~400 tokens, 256 KiB hard cap, trimmed by rank); re-put on
  change. Pull details on demand with `mem_find` / `mem_get`.
- **`/memory` owner override:** browse/edit/delete/export/audit in the app
  shell; the agent owns content, the owner has the last word. Plain text only,
  never rendered Markdown/HTML. One i18n string set in `en`/`de`.
- **Lifecycle:** supersede instead of overwrite (old row kept and linked, with
  a reason); TTL 90 days for `inferred`/`observed`, a year-or-never for
  `explicit`; only confirmation or reuse renews — retrieval never does;
  agent-invoked prune with a weekly dry-run reminder; full audit.
- **L3 is staged, not discarded:** stage 0 BM25 over the fact store plus the
  injected index; stage 1 FTS5 over a redacted transcript export on owner
  sign-off; stage 2 embeddings only on an explicit owner decision. Store, audit,
  override and filters stay constant across stages.

## Open questions

- `OPEN:` Which schedule formats does OpenCode accept (interval, cron, once)?
- `OPEN:` Is there an API to cancel a running subagent independently?
- `OPEN:` How are background jobs surfaced in events?
