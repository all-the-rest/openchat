# OpenCode Capabilities — Evidence

Source: OpenCode 2.3.0, `GET /openapi.json` from the running server, the
published `@opencode/client@2.3.0` and `@opencode/sdk@2.3.0` type declarations,
plus the V2 docs for client, SDK, attachments, MCP, permissions and agents.
Captured 2026-11-17.

The client types were read from
`node_modules/@opencode/client/dist/promise/{client,api,generated/types}.d.ts`.
Where this file cites a method name, that name exists in those declarations;
HTTP paths are shown only as context.

This file is an evidence appendix for
[`../matrix/01-feasibility.md`](../matrix/01-feasibility.md). It is not a
specification.

## Server and transport

- `server.info()` returns version, PID, hostname, URLs, paths and capabilities
  (e.g. `persistentPty`).
- `event.subscribe({ types })` is the stream; `server.connected` marks a
  reconnect.
- `server.pair()` and `server.connect()` provide the pairing flow.
- The API is described as experimental `HttpApi`; the OpenAPI document is the
  contract, not the framework.

## Sessions

| Operation | Client method |
| --- | --- |
| List/create | `session.list({ limit, order, search, archived, directory, cursor })`, `session.create()` |
| Get/update/delete | `session.get()`, `session.update()`, `session.remove()` |
| Prompt | `session.prompt({ delivery: "queue" })` |
| Messages | `message.list()`, `session.message.get()` |
| Interrupt | `session.interrupt({ sessionID, resume? })` |
| Fork | `session.fork()` |
| Revert | `session.revert.stage/commit/clear()` |
| Compact | `session.compact()` |
| Switch model/agent | `session.switchModel()`, `session.switchAgent()` |
| Context/diff/stats | `session.context()`, `session.diff()`, `session.stats()` |
| Shell | `session.shell()` |
| View/synthetic | `session.view()`, `session.synthetic()` |
| Active sessions | `session.active()` |
| Export/import | `session.export()`, `session.import()` |
| Wait | `session.wait()` |
| Inbox | `session.inbox.list({ sessionID })`, `session.inbox.cancel()`, `session.inbox.update()` |
| Forms | `session.form.list/get/create/reply/cancel()` |

`session.prompt` returns a `SessionInboxUser`, not the assistant message: the
turn is enqueued and the runner picks it up. Progress is observed through
`session.inbox.*` and the step events.

## Prompt input

```json
{
  "text": "string",
  "files": [{
    "uri": "file:///…",
    "source": { "type": "uri", "uri": "…" },
    "name": "…",
    "description": "…",
    "mention": { "start": 0, "end": 0, "text": "…" }
  }],
  "agents": [{ "name": "…" }],
  "skills": [{ "id": "…" }],
  "metadata": {},
  "delivery": "steer | queue",
  "resume": true
}
```

`delivery` defaults to the session's configured value; this app submits
`"queue"`. `agents` takes names, not IDs (verified against
`SessionPromptInput`).

Attachments: absolute `file:` or `data:` URLs; no HTTP(S). Text, directories,
PNG/JPEG/GIF/WebP and PDF are visible to the model. 20 MiB limit. SVG is text;
audio/video are not included.

## Messages

- User: `text`, `files`, `agents`, `skills`, `metadata`, `time`.
- Assistant: `content[]` of `text`, `reasoning`, `tool`; plus `agent`, `model`,
  `snapshot`, `finish`, `cost`, `tokens`, `error`, `retry`.
- Tool state: `streaming`, `running`, `completed`, `error`; time fields
  `created`, `ran`, `completed`.
- Other message types: system, compaction, shell, synthetic, model/agent
  selected, location switched.

## Event catalog

Durable session events:

```
session.created, session.renamed, session.moved, session.archived,
session.unarchived, session.deleted, session.forked,
session.agent.selected, session.model.selected, session.metadata.updated,
session.permissions, session.viewed, session.idle,
session.inbox.enqueued, session.inbox.delivered, session.inbox.cancelled,
session.inbox.delivery.changed,
session.execution.started, session.execution.succeeded,
session.execution.failed, session.execution.interrupted,
session.instructions.updated, session.synthetic, session.skill.activated,
session.status,
session.shell.started, session.shell.ended,
session.step.started, session.step.first-token, session.step.streamed,
session.step.ended, session.step.failed,
session.text.started, session.text.ended,
session.reasoning.started, session.reasoning.ended,
session.tool.input.started, session.tool.input.ended,
session.tool.called, session.tool.success, session.tool.failed,
session.retry.scheduled,
session.compaction.started, session.compaction.ended,
session.compaction.failed,
session.revert.staged, session.revert.cleared, session.revert.committed,
session.usage.updated
```

Transient deltas:

```
session.text.delta, session.reasoning.delta, session.tool.input.delta,
session.tool.progress, session.compaction.delta
```

Other:

```
permission.asked, permission.replied,
form.created, form.replied, form.cancelled,
agent.updated, artifact.updated, command.updated, config.updated,
credential.updated, credential.switched, experimental.mcp.event,
filesystem.changed, installation.update-available, installation.updated,
integration.updated, location.shutdown,
mcp.resources.changed, mcp.status.changed,
model.updated, models-dev.refreshed,
persistent-pty.added, persistent-pty.removed, persistent-pty.updated,
plugin.updated, project.updated, provider.updated,
pty.created, pty.updated, pty.deleted, pty.exited,
reference.updated, server.connected, shell.created, shell.deleted,
shell.exited, skill.updated, vcs.branch.updated, websearch.updated,
worktree.updated, worktree.resolved
```

`event.subscribe({ types })` narrows the payload union; an unknown type is a
type error, and `rpc.${string}` and the `tui.*` events are also part of the
union.

## Agents and models

- `agent.list()`, `agent.get({ agentID })`.
- `model.list()`, `model.default()`, `provider.list()`, `provider.get()`.
- Agent config: `description`, `mode` (`primary`, `subagent`, `all`), `model`,
  `system`, permissions.
- Built-ins: `build`, `plan`, `general`, `explore`; hidden `compaction`,
  `title`, `summary`.

## Permissions

- V2 rules: ordered `{ action, resource, effect }`, last match wins.
- Effects: `allow`, `deny`, `ask`.
- Actions: `read`, `edit`, `glob`, `grep`, `shell`, `subagent`, `skill`,
  `question`, `webfetch`, `websearch`, `experimental_image_generate`,
  `external_directory`, MCP `<server>_<tool>`, `execute`.
- Requests: `permission.asked`, `permission.replied`.
- Pending: `permission.list()`, `permission.get()`; saved rules:
  `permission.saved.*`.
- Reply: `permission.reply({ sessionID, requestID, decision })`.

## Forms

- `session.form.list()`, `session.form.get()`, `session.form.reply()`,
  `session.form.cancel()`, `session.form.create()`.
- Field types: string (with options), number, integer, boolean, multiselect,
  external; per-field `when`, `hidden`, `required`, `default`.
- Events: `form.created`, `form.replied`, `form.cancelled`.

## MCP

- `mcp.list()` (servers + status).
- `mcp.resource.catalog()` (catalog; `mcp.resources.changed`).
- `experimental.mcp.add/remove/connect/disconnect`.
- Config: `mcp.servers.<name>` with `type: local|remote`, `command`, `url`,
  `disabled`.
- Status: `connected`, `pending`, `needs auth`, `failed`, `disabled`.
- Events: `mcp.status.changed`, `mcp.resources.changed`.

## Artifacts

- `experimental.artifacts.providers()` → `{ id, name, capabilities[], default }`.
- `experimental.artifacts.list({ sessionID?, provider? })` → `ArtifactInfo[]`.
- `experimental.artifacts.create({ title, files: Record<path, string>, entry?, provider?, sessionID? })`.
- `experimental.artifacts.update({ artifactID, title?, files, entry?, sessionID? })`.
- `experimental.artifacts.get({ artifactID })` → `{ info, files }`.
- `experimental.artifacts.view({ artifactID, path })` → `Uint8Array`.
- `experimental.artifacts.delete({ artifactID })`.
- `ArtifactInfo`: `{ id, provider, sessionID?, title, entry, url, time }`.
- Event: `artifact.updated`.

This is a storage and serving API, not just a viewer hook: the app does not
need to implement an artifact store.

## Image generation

- `experimental.generate.image({ model, prompt, images?, n?, aspect?, resolution? })`.
- `model` is explicit: `{ id, providerID, variant? }`.
- `aspect` is a string such as `"16:9"`; `resolution` is `1K | 2K | 4K`.
- `images` array enables editing an existing image.
- Permission action: `experimental_image_generate` with the selected model.
- Provider/model must support images; `model.list({ types: ["image"] })`
  returns the candidates, so the feature can be hidden when empty.

## Voice

- `voice.models()`, `voice.session()` (also under `experimental.voice.*`).
- Treat as optional and provider-dependent; verify the transport against the
  installed version rather than assuming one.

## Schedules and background jobs

- `experimental.schedule.create/list/get/pause/resume/delete`.
- `list` requires a `sessionID`; create carries the prompt and an end condition
  (`ends.after | at | times`).
- `experimental.job.list({ sessionID?, kind?, status?, descendants? })` returns
  `JobInfo = JobShell | JobSubagent | JobImage`, each with
  `status: running | completed | error | cancelled`.
- `session.background()` starts background work.
- Runs server-side; the UI must say so.

## Files, VCS, worktrees

- `file.list()`, `file.find()`, `file.read()`; `experimental.file.write/watch`.
- `vcs.status()`, `vcs.diff()`, `vcs.branch.list()`, `vcs.init()`.
- `worktree.list/create/remove/refresh`.

## Shell, PTY, terminal

- `session.shell()` runs a shell command in a session.
- `shell.list/create/get/output/remove`.
- `pty.list/create/get/update/remove`, `pty.connect.token()`.
- `experimental.persistentPty.read/list/create/get/update/remove/shutdown/
  handoff/snapshot/connectToken`.
- Events: `pty.created|updated|deleted|exited`, `shell.created|deleted|exited`.

## Usage, cost, limits

- `experimental.usage.limits()` (also reachable as `usage.limits()`).
- `session.stats()` (experimental).
- Assistant messages carry `cost` and `tokens`.
- `session.usage.updated` event.
- Good enough for a usage panel; not a billing system.

## Web search

- `websearch.providers()` → configured providers.
- `websearch.query({ query })` → results for a direct query.
- `websearch.updated` event.
- The chat path is the agent's own search tool; the direct API is for a UI
  search affordance or for tests.

## Client and SDK

- `@opencode/client` (2.3.0): `OpenCode.make(options)` with
  `ClientOptions = { baseUrl, fetch?, headers? }`; resource groups (`session`,
  `event`, `agent`, `model`, `provider`, `mcp`, …); `event.subscribe({ types })`
  returns an `AsyncIterable` with a narrowed payload union.
- Promise values under `/promise`; streaming under `/effect`/`/solid` if the
  BFF ever needs the reactive variant.
- `@opencode/client/service`: `Service.discover()`, `ensure()`, `stop()`,
  `headers()` for a local background service.
- `@opencode/sdk` (2.3.0): `OpenCode.create()`, `sessions`, `events`,
  `worktree`, plugin registration; `await using` or `close()`.
- SDK opens no HTTP listener and routes calls through the router in memory.

## Caveats

- The API is labeled experimental; pin versions and generate types from the
  running server.
- Some operations (voice, schedules, persistent PTY) live on experimental
  routes; verify against the actual version.
- Event names and payloads must be validated at runtime; do not assume they are
  stable across minor versions.
- **Todos are unverified.** The 2.3.0 client has no todo method and the event
  union has no todo event; only an `experimental.todo` config flag is known. A
  planning view needs a spike against the installed version.
- Artifacts, schedules, jobs and inbox are confirmed client methods, but they
  are still `experimental.*` surface. Check the corresponding config flag
  against the pinned version, enable it explicitly and record it before
  shipping the feature.
- The reference product's internal APIs and prompts are not part of this
  evidence and are not to be extracted.
