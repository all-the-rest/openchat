# OpenCode Capabilities — Evidence

Source: OpenCode 2.3.0, `GET /openapi.json` from the running server, plus the V2
docs for client, SDK, attachments, MCP, permissions and agents. Captured
2026-11-17.

This file is an evidence appendix for
[`../matrix/01-feasibility.md`](../matrix/01-feasibility.md). It is not a
specification.

## Server and transport

- `GET /api/info` returns version, PID, hostname, URLs, paths and capabilities
  (e.g. `persistentPty`).
- `GET /api/event` is the SSE stream.
- `POST /api/pair` + `/auth/connect/:code` provide a pairing flow.
- The API is described as experimental `HttpApi`; the OpenAPI document is the
  contract, not the framework.

## Sessions

| Operation | Endpoint |
| --- | --- |
| List/create | `GET/POST /api/session` |
| Get/update/delete | `GET/PATCH/DELETE /api/session/:id` |
| Prompt | `POST /api/session/:id/prompt` |
| Message list/get | `GET /api/session/:id/message`, `.../:messageID` |
| Interrupt | `POST /api/session/:id/interrupt` |
| Fork | `POST /api/session/:id/fork` |
| Revert | `POST /api/session/:id/revert/stage|commit`, `DELETE /revert` |
| Compact | `POST /api/session/:id/compact` |
| Switch model/agent | `POST /api/session/:id/model|agent` |
| Context/diff/environment | `GET /api/session/:id/context|diff|environment` |
| Shell | `POST /api/session/:id/shell` |
| View/synthetic | `POST /api/session/:id/view|synthetic` |
| Active sessions | `GET /api/session/active` |
| Export/import | `POST /api/experimental/session/:id/export`, `.../import` |
| Wait/stats/log | `.../wait`, `.../stats`, `.../log` |
| Inbox | `GET /api/session/:id/inbox`, `.../:inboxID/cancel` |
| Forms | `GET /api/session/:id/form`, `.../:formID/reply` |

## Prompt input

```json
{
  "text": "string",
  "files": [{ "uri": "file:///…", "name": "…", "description": "…" }],
  "agents": [{ "id": "…" }],
  "skills": [{ "id": "…" }],
  "metadata": {},
  "delivery": null,
  "resume": null
}
```

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
session.usage.recorded, session.message.content.updated
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
mcp.status.changed, mcp.resources.changed,
model.updated, provider.updated, agent.updated, config.updated,
artifact.updated, filesystem.changed,
pty.created, pty.updated, pty.deleted, pty.exited,
project.updated, integration.updated, installation.updated,
location.shutdown
```

## Agents and models

- `GET /api/agent`, `GET /api/agent/:id`.
- `GET /api/model`, `GET /api/model/default`, `GET /api/provider`,
  `GET /api/provider/:id`.
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
- Pending: `GET /api/permission/request`; saved rules:
  `GET /api/permission/saved`.
- Reply: `POST /api/session/:id/permission/:requestID/reply`.

## Forms

- `GET /api/session/:id/form`, `GET .../:formID`, `POST .../reply`.
- Field types: string (with options), number, integer, boolean, multiselect,
  external; per-field `when`, `hidden`, `required`, `default`.
- Events: `form.created`, `form.replied`, `form.cancelled`.

## MCP

- `GET /api/mcp` (servers + status).
- `GET /api/mcp/resource` (catalog).
- `POST /api/experimental/mcp/:server`, `.../connect`, `.../disconnect`.
- Config: `mcp.servers.<name>` with `type: local|remote`, `command`, `url`,
  `disabled`.
- Status: `connected`, `pending`, `needs auth`, `failed`, `disabled`.
- Events: `mcp.status.changed`, `mcp.resources.changed`.

## Artifacts

- `GET /api/experimental/artifacts` — list.
- `GET /api/experimental/artifacts/:id` — metadata.
- `GET /api/experimental/artifacts/:id/view/*` — content.
- Shape: `{ id, provider, sessionID, title, entry, url, time }`.
- `GET /api/experimental/artifacts/providers`.
- `artifact.updated` event.

## Image generation

- `POST /api/experimental/generate/image`.
- Request includes prompt, aspect ratio, resolution and output options.
- Response contains image results/media.
- Permission action: `experimental_image_generate` with the selected model.
- Provider/model must support images; hide the feature otherwise.

## Voice

- `GET /api/experimental/voice/models`.
- `POST /api/experimental/voice/session`.
- Treat as optional and provider-dependent; verify the transport against the
  installed version rather than assuming one.

## Schedules and background jobs

- `POST /api/experimental/schedule`.
- `GET /api/experimental/schedule/:id`.
- `POST /api/experimental/schedule/:id/pause|resume`.
- `GET /api/experimental/job`.
- `session.background`, `Job.Image`, `Job.Subagent`, `Job.Shell`,
  `Job.Status`.
- Runs server-side; the UI must say so.

## Files, VCS, worktrees

- `GET /api/fs/list`, `/api/fs/find`, `/api/fs/read/*`.
- `POST /api/experimental/fs/write`, `GET /api/experimental/fs/watch`.
- `GET /api/vcs/status|diff|branch|base`; `POST /api/vcs/init`.
- `GET/POST/DELETE /api/worktree`, `POST /api/worktree/refresh`.

## Shell, PTY, terminal

- `POST /api/session/:id/shell`.
- `GET /api/shell`, `/api/shell/:id`, `/api/shell/:id/output`.
- `GET /api/pty`, `/api/pty/:id`, `/api/pty/:id/connect`,
  `/api/pty/:id/connect-token`.
- Experimental persistent PTY: `GET /api/experimental/persistent-pty/:id`,
  `/connect`, `/connect-token`, `/snapshot`, `/handoff`, `/shutdown`.
- Events: `pty.created|updated|deleted|exited`.

## Usage, cost, limits

- `GET /api/experimental/usage/limits`.
- `GET /api/experimental/session/stats`.
- Assistant messages carry `cost` and `tokens`.
- Good enough for a usage panel; not a billing system.

## Client and SDK

- `@opencode/client` (2.3.0): `OpenCode.make({ baseUrl, headers })`; resource
  groups (`session`, `event`, `agent`, `model`, `provider`, `mcp`, …);
  `event.subscribe({ types })`; `AsyncIterable` streams.
- `@opencode/client/service`: `Service.discover()`, `ensure()`, `stop()`,
  `headers()` for a local background service.
- `@opencode/sdk` (2.3.0): `OpenCode.create()`, `sessions`, `events`,
  `worktree`, plugin registration; `await using` or `close()`.
- SDK opens no HTTP listener and routes calls through the router in memory.

## Caveats

- The API is labeled experimental; pin versions and generate types from the
  running server.
- Some operations (voice, schedules) are only described in the SDK docs or
  experimental routes; verify against the actual version.
- Event names and payloads must be validated at runtime; do not assume they are
  stable across minor versions.
- **Todos are unverified.** The 2.3.0 OpenAPI has no todo endpoint and the event
  union has no todo event; only an `experimental.todo` config flag is known. A
  planning view needs a spike against the installed version.
- Experimental features are behind `experimental.*` config keys. The 2.3 OpenAPI
  documents only `experimental.mcp.event`; artifact, todo and schedule flags are
  not confirmed by the document. Verify the exact name against the pinned
  version, enable it explicitly and record it before shipping the feature.
- The reference product's internal APIs and prompts are not part of this
  evidence and are not to be extracted.
