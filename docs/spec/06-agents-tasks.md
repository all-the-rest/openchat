# 06 — Agents and Tasks

## Agents

- List agents from `GET /api/agent`.
- Show name, description, mode (primary/subagent) and model.
- Select a primary agent per session.
- Subagents are started by the primary agent through the subagent tool; the UI
  shows parent/child sessions and their status.
- The UI never silently changes the agent.

## Planning and todos

- OpenCode's todo tool produces a task list.
- Render todos as a checklist with status: pending, in progress, completed,
  cancelled.
- Update live from events; do not poll.
- A todo list belongs to a session, not to the global task board.

## Task board

The global `/tasks` route combines:

1. **Scheduled tasks** — OpenCode schedules (`experimental/schedule/*`).
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

- List worktrees for a project.
- Create a worktree for a task; show its directory and branch.
- Removing a worktree requires confirmation and must refuse if uncommitted
  changes exist, unless the user explicitly forces it.
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

## Open questions

- `OPEN:` Which schedule formats does OpenCode accept (interval, cron, once)?
- `OPEN:` Is there an API to cancel a running subagent independently?
- `OPEN:` How are background jobs surfaced in events?
