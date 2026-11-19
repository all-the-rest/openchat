# 24 — Scheduled tasks and background jobs

**Status:** 2026-11-18. Implements the task-board slice of issue #7 (M5).
Design sources are our own documents — `docs/spec/06-agents-tasks.md`,
`docs/spec/02-information-architecture.md`, `docs/spec/10-acceptance.md` and
`docs/architecture/02-opencode-integration.md` — plus the public surface of
`@opencode/client@2.3.0`. No implementation, UI text, prompt or test was taken
from another repository or from a reference capture.

## Honest scope

v1 ships the two data-backed sections of the `/tasks` route: server schedules
and background jobs. The page states, in an i18n note, that schedules run on the
server even when the browser is closed (spec 06, architecture 02). A schedule
is a **one-shot prompt**: the form's end condition chooses when it fires.

| Layer | What is in v1 |
| --- | --- |
| Contract | `Schedule`, `BackgroundJob`, `CreateScheduleRequest`, `scheduleEndsSchema` |
| Backend port | `listSchedules`, `createSchedule`, `pauseSchedule`, `resumeSchedule`, `deleteSchedule`, `listJobs` |
| Live adapter | Thin forwarding to `experimental.schedule.*` and `experimental.job.list()` |
| Fake adapter | Deterministic in-memory store; no host, no clock except the injected one |
| BFF | Six authenticated routes with stable error codes |
| Web | `/tasks` inside the app shell, one sidebar entry, full `en`/`de` catalogues |
| Tests | Contract validation, adapter mapping, route guards, page states, offline E2E |

## End-condition mapping

The SDK create shape has both `when` (the fire time: `in`, `at`, `every`,
`cron`) and `ends` (a stop condition: `after`, `at`, `times`). Our documents
describe the create shape as "the prompt and end condition (`ends.after | at |
times`)" and the form asks for "after N minutes or at a time". v1 maps that
single form field onto the SDK's one-shot `when` so the created schedule
actually fires:

- `ends.after: "30 minutes"` → `when: { type: "in", in: "30 minutes" }`
- `ends.at: "2026-11-20T09:30"` → `when: { type: "at", at: "2026-11-20T09:30" }`

Caps are structural, so tests are deterministic: `after` is 1..90 days
(seconds, minutes, hours, days or weeks) and `at` is a 4-digit year from 2000
to 2100 with a parseable date. `prompt` is 1..4000 characters. A body that
omits `prompt`, supplies both end fields, or fails a cap is rejected with
`400 invalid_request` before the backend is called.

Interval and cron schedules are deliberately not offered: they need a richer
recurrence picker than the siblings' agent/model pickers, which are out of this
slice's scope. The host's `ends` stop condition is not exposed either, because
a one-shot schedule ends by construction.

## Contract fields

`Schedule` carries `id`, `sessionID`, `title`, `prompt`, `status`
(`active | paused | done`), `nextRunAt`, `endsAt`, `runCount`, `lastRunAt`,
`lastOutcome`, `lastError`, `created`, `updated`. `title` is the host name or a
prompt excerpt; `lastError` is bounded text from a failed run and is the only
error text the UI shows. `BackgroundJob` carries `id`, `sessionID`, `kind`
(`shell | subagent | image`), `status` (`running | completed | error |
cancelled`), `title`, `started`, `finished`. Host-only fields (conditions,
time zone, shell commands, subagent ids and image paths) stay in the adapter.

## Routes

| Route | Result |
| --- | --- |
| `GET /api/sessions/:id/schedules` | `200` + schedule array |
| `POST /api/sessions/:id/schedules` | `201` + new schedule; `400 invalid_request` bad body, `404 not_found` unknown session |
| `POST /api/schedules/:id/pause` | `200` + updated schedule; `404 not_found` unknown id |
| `POST /api/schedules/:id/resume` | `200` + updated schedule; `404 not_found` unknown id |
| `DELETE /api/schedules/:id` | `200 { ok: true }`; `404 not_found` unknown id |
| `GET /api/jobs` | `200` + flat job array |

Authentication and the JSON content-type rule are the global `/api/*` guards,
unchanged. `BackendError` codes are mapped by `app.onError`: `not_found` →
404, everything else → 400. The live adapter maps a host rejection by its
structured `_tag` (`ScheduleNotFoundError` / `SessionNotFoundError` →
`not_found`, `InvalidRequestError` → `invalid`, otherwise `unavailable`) and
never forwards upstream text, which may carry tokens or workspace paths.

## Fake store behaviour

`FakeTaskStore` (behind `FakeBackend`) keeps one map of schedules keyed by an
incrementing `sch_1`, `sch_2`, … id and an optional injected job list:

- `create` requires the session to exist, then stores an `active` row with
  `runCount: 0` and `created`/`updated` from the injected clock. A validated
  `after` resolves to `now + duration`; `at` is parsed directly. Both populate
  `nextRunAt` and `endsAt` (a one-shot schedule ends when it fires).
- `list` returns copies of one session's rows, oldest first. `pause` moves
  `active → paused`, `resume` only unpauses a paused row, `delete` removes it;
  an unknown id is always `not_found`, and a `done` row cannot be paused.
- `jobs` returns copies sorted with running jobs first and newest first. The
  default list is empty; tests seed it through `seedJobs`.
- Nothing fires on a timer. The fake is a state store for the UI, not a
  scheduler.

## UI controls

The `/tasks` page loads sessions, their schedules and the flat job list, then
renders two labelled sections. Schedule rows show title, prompt, status,
session link, next run or end condition, run count, last run and a bounded
failed-run error. Row actions are Pause, Resume and Delete; Delete needs a
second Confirm click and offers Cancel. The create form has a session select,
a prompt textarea, an after/at choice with a duration or datetime input, and a
submit button. Jobs show kind, title, status, session link and started/finished
times, running first. `orderJobs` sorts defensively in the browser as well as
in the fake store.

## Worktrees

The `/worktrees` route implements the worktree slice of spec 06 and FR-23. It
listens to the host surface that already exists in `@opencode/client@2.3.0`:
`worktree.list({ projectID })`, `worktree.create({ projectID, from?, branch?,
directory?, name? })` and `worktree.remove({ projectID, directory, force })`.
`refresh` is not called; the page re-reads after every mutation.

| Layer | What is there |
| --- | --- |
| Contract | `WorktreeInfo` (`directory`, `branch?`, `name?`, `projectID?`, `strategy?`), `WorktreesResponse`, `createWorktreeRequestSchema`, `removeWorktreeQuerySchema` |
| Backend port | `listWorktrees()`, `createWorktree(input)`, `removeWorktree(directory, force)` |
| Live adapter | `live-worktrees.ts`; resolves the project, fills the branch from `vcs.get` |
| Fake adapter | `fake-worktrees.ts`; one seeded clean worktree, no host needed |
| BFF | `GET /api/worktrees`, `POST /api/worktrees`, `DELETE /api/worktrees?directory=…&force=true\|false` |
| Web | `/worktrees` page, an entry in the app menu and one in the desktop sidebar, full `en`/`de` catalogues |

**What the host really reports.** `worktree.list` returns only `directory` and
an optional `strategy`; create returns only `directory`. The branch is a second,
per-worktree `vcs.get` read and therefore stays optional — a host without VCS
answers renders "Branch not reported" instead of an invented name. The BFF
resolves the project once per call: the host project whose canonical path
matches `WORKSPACE_DIR`, else the only project the host reports; no project is
an `unsupported` surface. Every row and the list response carry that id.

**Project and branch are server-side decisions.** The browser never sends a
`projectID` or a directory for creation; the BFF passes the workspace project
and the adapter derives the directory through the host. The create body is
`{ branch, from?, name? }`, with `branch` restricted to ref-safe characters
(letters, digits, `. _ / -`, no `..`, no leading or trailing `/`).

**Force rule.** A removal without `force` is a plain removal. When the host
refuses because the tree has uncommitted changes (its declared
`WorktreeError` body carries `forceRequired: true`), the live adapter throws
`WorktreeDirtyError`, and the BFF answers `409` with the distinct code
`worktree_dirty`. It never retries
with `force: true`. Only the UI's explicit "Force removal" button sends
`force=true`, and its dialog states that this discards uncommitted changes.
`force` is parsed strictly (`true` or `false`); any other spelling is
`400 worktree_invalid`.

**Fake semantics.** `FakeWorktreeStore` lives under `<workspace>/.worktrees`
and derives a directory slug from the branch (`feat/worktrees` →
`feat-worktrees`). A second worktree for the same branch is `conflict`
(`409 worktree_exists`); an unknown directory is `not_found`
(`404 worktree_unknown`). Tests mark a tree dirty through
`FakeBackend.markWorktreeDirty(directory)`, which makes an unforced removal
throw `WorktreeDirtyError`, exactly like the host.

**Removal is restricted to host-listed directories.** `DELETE /api/worktrees`
resolves `worktree.list` first and forwards only a directory the host actually
listed (one trailing slash is ignored). An unlisted path, including the project
root even when the host lists it, is `404 worktree_unknown` and never reaches
`worktree.remove`; a failed list is `502 worktrees_unavailable`. The BFF still
passes the host's own spelling, not the client string, so a client cannot
smuggle a path through.

**Creation is bounded.** `POST /api/worktrees` is throttled per address
(6 requests per 60 s, injectable) and answers `429 too_many_requests` with
`Retry-After`. The budget is spent before the host create call, so a create the
host then refuses (duplicate branch, dirty tree, outage) still counts; a
validation or cap refusal above never reaches the host and never counts. A
project that already lists 16 removable worktrees answers `409 worktree_limit`
with a fixed message before the host is asked to create another;
`worktrees.create.limit` renders it. A missing project/list is 502, not a create
attempt.

**UI.** The app bar's overflow menu (below `lg`) and the desktop sidebar both
link `/worktrees`, each only when the Code surface is configured. The removal
dialog owns focus: initial focus on Cancel, Tab wraps inside, Escape cancels,
and focus returns to the row action that opened it.

**Live create failures are classified, not guessed.** `worktree.create`
declares `WorktreeError` — the host's domain refusal (branch or worktree
already exists, git refused) — and `ProjectNotFoundError`. The adapter maps a
declared `WorktreeError` or any other declared 4xx (`InvalidRequestError`) to
`invalid` (`400 worktree_invalid`), a declared `ProjectNotFoundError` (or an
undeclared `404`) to `not_found`, and a transport error, timeout, 5xx or
malformed answer to `unavailable` (`502 worktrees_unavailable`). A `409` is not
part of the declared create union; only an undeclared `UnexpectedStatus`
carrying it can occur, and the adapter maps that to `conflict`
(`409 worktree_exists`) defensively. A dropped host is never reported as a bad
branch name.

**`not_found` on create stays a `502`.** When the workspace project vanishes
between listing and creating, the adapter reports `not_found` (the same code
`DELETE` maps to `404 worktree_unknown`). The create route deliberately has no
`not_found` arm: a create cannot proceed without its project, so it falls
through to `502 worktrees_unavailable` rather than naming a missing worktree.
The adapter code and the route answer are not in conflict — they describe
different layers, and the route test pins the `502`.

Other stable route codes: `400 worktree_invalid` for a failed body/query or a
refused create, and `502 worktrees_unavailable` when the host does not answer.

## Explicitly out of scope

- **Todos / planning panel.** The pinned client has no todo endpoint and the
  event union has no todo event; only an `experimental.todo` config flag is
  known. Spec 06 requires a spike before any panel exists. Today the agent's
  plan renders as an ordinary tool card or Markdown list, so this slice adds
  no empty todo section.
- **Subagent parent/child tree.** There is no session-tree API. `job.list`
  shows subagent jobs flat in this v1; no hierarchy is invented.
- **Worktrees.** They need a project/repository selection first; v1 runs in a
  single `WORKSPACE_DIR` (spec 06). The list/create/remove slice now lives on
  `/worktrees` (see above); running a task *in* a chosen worktree is still a
  later step, because a task start would need the worktree's directory plumbed
  into a session create.
- **Citations / source cards.** A separate research slice; no web search or
  citation data is on this page.
- **Agent and model pickers for a schedule.** Both siblings own those pickers;
  the create form intentionally has neither. They are an additive follow-up
  once those pickers are shared components.

## Verification

`pnpm run gates:fast` and `CI=1 pnpm --filter @openchat/web exec playwright
test` must be green. The offline E2E creates a schedule on a fresh chat, sees
it listed, pauses it, reloads and still sees it paused, then deletes it; no
request leaves the test host. Two guard regressions are asserted explicitly:
a body without `prompt` is rejected with `400 invalid_request`, and pausing an
unknown schedule id is rejected with `404 not_found`.
