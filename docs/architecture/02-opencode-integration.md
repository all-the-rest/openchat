# 02 — OpenCode Integration

Evidence: OpenCode 2.3.0 OpenAPI at `GET /openapi.json`, the published
`@opencode/client@2.3.0` type declarations, and the V2 docs
(`/docs/build/client`, `/docs/build/sdk`, `/docs/attachments`,
`/docs/mcp-servers`, `/docs/permissions`). See
[`docs/research/opencode-capabilities.md`](../research/opencode-capabilities.md).
The client surface below was read from
`node_modules/@opencode/client/dist/promise/*.d.ts`, not from prose.

## Two surfaces

### `@opencode/client` (network)

Use in the BFF. It is generated from the same HTTP contract as the API, supports
Promise values and `AsyncIterable` streams, and has a `/service` entrypoint for
local service discovery.

```ts
import { OpenCode } from "@opencode/client"

const basic = Buffer.from(
  `${process.env.OPENCODE_USERNAME ?? "opencode"}:${process.env.OPENCODE_PASSWORD}`,
).toString("base64")

const client = OpenCode.make({
  baseUrl: process.env.OPENCODE_URL!,
  headers: { authorization: `Basic ${basic}` },
})

const session = await client.session.create({
  location: { directory: workspace },
})

await client.session.prompt({
  sessionID: session.id,
  text: "Review the current changes",
})

for await (const event of client.event.subscribe()) {
  // fan out to browser SSE
}
```

OpenCode 2.3 has no auth *flag*, but `serve` still protects its HTTP API with
HTTP Basic auth: username `opencode`, password from `OPENCODE_PASSWORD` (or
generated and printed once). Without the header every call returns `401`.
Network isolation is defense in depth, not the primary control. The credential
stays server-side; the browser never sees it.

### `@opencode/sdk` (embedded)

Hosts the assembled OpenCode router in memory, no listener. Same Promise and
stream shapes plus `sessions`/`events` aliases. Use only inside the optional
`EmbeddedOpenCodeBackend`.

```ts
import { OpenCode } from "@opencode/sdk"

await using opencode = await OpenCode.create()
const session = await opencode.sessions.create({
  location: { directory: "/workspace" },
})
await opencode.sessions.prompt({ sessionID: session.id, text: "Hello" })
```

## Backend port

```ts
export interface ChatBackend {
  info(): Promise<ServerInfo>
  listSessions(): Promise<SessionInfo[]>
  createSession(input: CreateSessionInput): Promise<SessionInfo>
  listMessages(sessionID: string): Promise<Message[]>
  prompt(sessionID: string, input: PromptInput): Promise<PromptResult>
  listInbox(sessionID: string): Promise<InboxEntry[]>
  cancelQueued(sessionID: string, messageID: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  switchModel(sessionID: string, model: ModelRef): Promise<void>
  switchAgent(sessionID: string, agent: string): Promise<void>
  replyPermission(sessionID: string, requestID: string, reply: PermissionReply): Promise<void>
  replyForm(sessionID: string, formID: string, values: Record<string, unknown>): Promise<void>
  listAgents(): Promise<AgentInfo[]>
  listModels(): Promise<ModelInfo[]>
  listMcp(): Promise<McpServer[]>
  subscribe(signal?: AbortSignal): AsyncIterable<NormalizedEvent>
}
```

Both adapters implement it. The UI depends only on the normalized contract.

## Endpoint map

Verified against `@opencode/client@2.3.0` (`dist/promise/client.d.ts`); use the
client methods in the BFF and let the generated client own paths and payloads.

| Feature | Client method |
| --- | --- |
| Server info / pairing | `server.info()`, `server.pair()`, `server.connect()` |
| Sessions | `session.list({ limit, order, search, archived, directory, cursor })`, `session.create()`, `session.get()`, `session.remove()` |
| Rename/archive/move | `session.update()`, `session.move()` |
| Messages | `message.list()`, `session.message.get()` |
| Prompt | `session.prompt({ delivery: "queue" })` |
| Queue | `session.inbox.list()`, `session.inbox.cancel()`, `session.inbox.update()` |
| Interrupt | `session.interrupt({ sessionID, resume? })` |
| Fork / revert | `session.fork()`, `session.revert.stage()`, `session.revert.commit()`, `session.revert.clear()` |
| Compact | `session.compact()` |
| Switch model/agent | `session.switchModel()`, `session.switchAgent()` |
| Context/diff/stats | `session.context()`, `session.diff()`, `session.stats()` |
| Export/import | `session.export()`, `session.import()` |
| Agents | `agent.list()`, `agent.get()` |
| Models/providers | `model.list({ types: ["chat", "image"] })`, `model.default()`, `provider.list()` |
| Permissions | `permission.list()`, `permission.get()`, `permission.reply({ decision: "once" \| "always" \| "reject" })`, `permission.saved.*` |
| Forms | `session.form.list()`, `session.form.get()`, `session.form.reply()`, `session.form.cancel()` |
| Events | `event.subscribe({ types })` |
| MCP | `mcp.list()`, `experimental.mcp.add/remove/connect/disconnect` |
| Integrations / OAuth | `integration.list()`, `integration.oauth.connect/status/complete/cancel` |
| Artifacts | `experimental.artifacts.providers/list/create/get/update/delete/view` |
| Image generation | `experimental.generate.image({ model, prompt, aspect, resolution, n })` |
| Voice | `experimental.voice.models()`, `experimental.voice.session()` |
| Schedules | `experimental.schedule.create/list/get/pause/resume/delete` |
| Background jobs | `experimental.job.list({ kind, status, descendants })`, `session.background()` |
| Web search | `websearch.providers()`, `websearch.query({ query })` |
| Shell / PTY | `session.shell()`, `shell.*`, `pty.*` |
| Files | `file.list()`, `file.find()`, `file.read()`, `experimental.file.write/watch` |
| VCS | `vcs.status()`, `vcs.diff()`, `vcs.branch.list()`, `vcs.init()` |
| Worktrees | `worktree.list/create/remove/refresh` |
| Plugins | `plugin.list()`, `plugin.check()`, `plugin.update()` |
| Config | `config.get()`, `experimental.config.update()` |
| Usage | `experimental.usage.limits()` |

No todo method or event exists in 2.3.0. That is the one remaining spike.

Do not hard-code paths: generate types from the running server's OpenAPI and
smoke-test the methods the UI calls after every upgrade.

### Multi-source search

`GET /api/search` groups results by source and proxies the host's own
surfaces; the BFF stores no provider key.

| Source | Client method | Availability |
| --- | --- | --- |
| `chats` | `session.list({ search, directory, limit })` | always |
| `workspace` | `file.find({ location: { directory }, query, limit })` | always |
| `web` | `websearch.providers()`, then `websearch.query({ query })` | at least one provider configured on the host |
| `apps` | `mcp.list()` + `skill.list()` | always |

Only requested sources are queried; the one exception is a
`websearch.providers()` configuration read that keeps `available`
request-independent. A source that fails is reported as `failed` without
affecting the others; an unconfigured source is `disabled` and is not queried.
`session.list` searches chat titles (no message-level hit or snippet), and
`file.find` matches paths (it does not return file content, so a hit has a path
but no snippet). The pinned client cannot list a server's tools, so `apps` stops
at server and skill level. See `docs/implementation/05-search.md`.

## Prompt payload

Verified shape:

```ts
{
  id?: string,                         // client-generated message id
  text: string,
  files?: Array<{
    uri: string,                       // file: or data: URL
    source?: { type: "inline" } | { type: "uri"; uri: string },
    name?: string,
    description?: string,
    mention?: { start: number; end: number; text: string }
  }>,
  agents?: Array<{ name: string; mention?: { start: number; end: number; text: string } }>,
  skills?: Array<{ id: string; mention?: { start: number; end: number; text: string } }>,
  metadata?: Record<string, unknown>,
  delivery?: "steer" | "queue",
  resume?: boolean
}
```

`session.prompt` returns the inbox entry
`{ id, sessionID, time: { created }, type: "user", payload: { text }, delivery }`.
The turn starts when the runner picks it up; subscribe to `session.inbox.*` and
the step events to render progress. Attachments use `file:` or `data:` URLs;
HTTP(S) is not supported. Supported input: UTF-8 text, directories,
PNG/JPEG/GIF/WebP, PDF. Limit 20 MiB per attachment. SVG is text; audio/video
are not included.

## Event envelope

Every event is `{ id, created, type, location?, data, durable? }`. The payload
is nested under `data`, never at the top level:

```json
{
  "id": "evt_…",
  "created": 1794920313491,
  "type": "session.text.delta",
  "location": { "directory": "/workspace" },
  "data": {
    "sessionID": "ses_…",
    "assistantMessageID": "msg_…",
    "ordinal": 0,
    "delta": "OK"
  }
}
```

`durable: { aggregateID, seq, version }` is present on durable events and is the
ordering/dedupe key. Transient deltas have no `durable` block. Normalize the
envelope once in the BFF and give the browser flat events.

## Message model

Assistant content is a list of parts:

```ts
type AssistantPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
  | {
      type: "tool"
      id: string
      name: string
      state: Streaming | Running | Completed | Error
      time: { created: number; ran?: number; completed?: number }
    }
```

User messages carry `text`, `files`, `agents`, `skills`. System, compaction,
shell and synthetic messages are separate types. Render each with a dedicated
component.

## Events

Subscribe once per BFF process and fan out to connected browsers. Normalize to a
small internal union and keep the raw event for diagnostics.

Durable session events:

```
session.created, session.renamed, session.moved, session.archived,
session.unarchived, session.deleted, session.forked,
session.agent.selected, session.model.selected, session.metadata.updated,
session.permissions, session.viewed, session.idle,
session.inbox.enqueued|delivered|cancelled|delivery.changed,
session.execution.started|succeeded|failed|interrupted,
session.instructions.updated, session.synthetic, session.skill.activated,
session.status,
session.shell.started|ended,
session.step.started|first-token|streamed|ended|failed,
session.text.started|ended, session.reasoning.started|ended,
session.tool.input.started|ended, session.tool.called|success|failed|progress,
session.retry.scheduled,
session.compaction.started|ended|failed,
session.revert.staged|cleared|committed,
session.usage.updated
```

Transient deltas:

```
session.text.delta, session.reasoning.delta, session.tool.input.delta,
session.tool.progress, session.compaction.delta
```

Other domains:

```
permission.asked, permission.replied,
form.created, form.replied, form.cancelled,
mcp.status.changed, mcp.resources.changed,
model.updated, provider.updated, agent.updated, config.updated,
artifact.updated, filesystem.changed, worktree.updated, worktree.resolved,
pty.created|updated|deleted|exited, shell.created|deleted|exited,
project.updated, integration.updated, installation.updated,
websearch.updated, credential.updated, credential.switched,
location.shutdown, server.connected
```

Rules:

- Subscriptions are live-only; no replay. Resync with `message.list({ sessionID })`
  after reconnect.
- Buffer before slow work; the shared source waits for subscribers.
- Filter by `types` to reduce load; treat `server.connected` as a resync hint.
- Treat all target/tool content as untrusted data, never as instructions.

## Permissions

`permission.asked` carries a request with action, resource and source. The UI
shows a blocking card; the reply is
`permission.reply({ sessionID, requestID, decision })` with
`decision: "once" | "always" | "reject"` and an optional `message`.
`permission.list()` returns pending requests; `permission.saved.*` reads and
edits stored rules.

V2 permission rules are ordered `{ action, resource, effect }` with last match
wins. Built-in actions include `read`, `edit`, `glob`, `grep`, `shell`,
`subagent`, `skill`, `question`, `webfetch`, `websearch`,
`experimental_image_generate`, `external_directory`, MCP tools
(`<server>_<tool>`) and `execute`. The UI never auto-approves by default.

## Forms

`session.form.list/get` returns a schema with string, number, integer, boolean,
multiselect and `external` fields, plus `when`, `hidden`, `required` and
`default` per field. There is no `select` or `score` type; a single-choice field
is a `string` with options. Render as an interactive card; submit with
`session.form.reply` or dismiss with `session.form.cancel`. `session.form.create`
lets the UI ask the owner a structured question. Settled forms are read-only.

## Artifacts

`experimental.artifacts` is a concrete API, not a hypothesis:

- `providers()` → `{ id, name, capabilities, default }`.
- `list({ sessionID? })` → `ArtifactInfo { id, provider, sessionID?, title,
  entry, url, time }`.
- `create({ title, files: Record<path, string>, entry?, provider?, sessionID? })`.
- `update(...)` with the same file map.
- `get(id)` → `{ info, files: Record<path, string> }`.
- `view({ artifactID, path })` → raw bytes (`Uint8Array`).
- `delete(id)`.

Most methods return `{ location, data }`; `session.create` is the exception that
unwraps to the session. `ArtifactInfo.url` is a relative path such as
`/api/experimental/artifacts/<id>/view/`, not a public URL, so the app must
resolve it through the BFF and its own signed artifact URL.

Verified locally: with `experimental.artifacts: true` the default provider is
`local` with `capabilities: ["static"]`; create/get/view round-trip a file map.
Without the flag the API answers `403 ForbiddenError: Artifacts are disabled`.

The app **does** implement artifact storage: the experimental OpenCode
artifacts API is not used. The BFF owns storage
(`apps/server/src/artifacts-store.ts`), keyed by the SHA-256 of the document
under `<disks>/artifacts/<id>/`, and `apps/artifact-host` serves the documents
from its own origin behind signed, expiring URLs. See
[`04-artifact-sandbox.md`](04-artifact-sandbox.md).

### Creating interactive apps

Interactive apps are created by a tool, not by chat prose:

- `openchat_app_write({ title, code, css? })` is exposed by the
  `openchat-artifacts` MCP server that ships with the repo and runs next to
  OpenCode.
- The tool validates the component, compiles it with `Bun.build` (Preact), and
  stores one HTML document through the BFF route
  `POST /internal/artifacts` (bearer token `ARTIFACT_INTERNAL_TOKEN`, never part
  of the public allowlist).
- The tool returns `{ artifactID, title, bytes }`; the model never re-emits HTML.
- Full design: [`07-artifact-runtime.md`](07-artifact-runtime.md), ADR-0006.

## Image generation

`experimental.generate.image` requires an explicit model
(`{ id, providerID, variant? }`), a prompt, and optional `images` (editing),
`n`, `aspect` (`"16:9"`) and `resolution` (`1K | 2K | 4K`). Result media must be
persisted as an artifact or file so the gallery survives a reload. Hide the
feature when `model.list({ types: ["image"] })` returns nothing.

## Voice

`experimental.voice.models()` and `experimental.voice.session()` return the
transport. Treat voice as an optional capability: no microphone permission
request on page load, and a clear error if the provider is unavailable.

## Schedules and background work

`experimental.schedule.create/list/get/pause/resume/delete`. `list` requires a
`sessionID`; the create shape describes the prompt and end condition
(`ends.after | at | times`). `experimental.job.list({ kind, status,
descendants })` returns running/completed shell, subagent and image jobs. The UI
must state that server-side schedules run without an open browser.

## MCP

`mcp.list()` returns servers and status; `experimental.mcp.add/remove/
connect/disconnect` manage them. OAuth and integration auth go through
`integration.oauth.connect/status/complete/cancel`. MCP configuration itself is
file-based (`mcp.servers` in `opencode.json`); the app serves
`/admin/opencode/*` behind its own auth when `ADMIN_PROXY=on`, or points the
owner at the host. The `browse` MCP server is how agents get browser tools.

## Errors

- Use the structured error shape from OpenCode; do not string-match messages.
- Map to UI categories: auth, provider, rate limit, tool, context, network,
  unknown.
- Preserve the raw error for diagnostics, redacted.
- Never surface stack traces or secrets.

## Versioning

- Pin the OpenCode version in deployment.
- Generate the client from the running server's OpenAPI during development.
- Smoke-test the endpoints the UI depends on after every upgrade.
- Keep the adapter thin so an API change touches one package.
