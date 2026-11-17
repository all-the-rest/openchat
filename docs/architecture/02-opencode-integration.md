# 02 — OpenCode Integration

Evidence: OpenCode 2.3.0 OpenAPI at `GET /openapi.json` and the V2 docs
(`/docs/build/client`, `/docs/build/sdk`, `/docs/attachments`,
`/docs/mcp-servers`, `/docs/permissions`). See
[`docs/research/opencode-capabilities.md`](../research/opencode-capabilities.md).

## Two surfaces

### `@opencode/client` (network)

Use in the BFF. It is generated from the same HTTP contract as the API, supports
Promise values and `AsyncIterable` streams, and has a `/service` entrypoint for
local service discovery.

```ts
import { OpenCode } from "@opencode/client"

const client = OpenCode.make({
  baseUrl: process.env.OPENCODE_URL!,
  headers: { authorization: `Bearer ${process.env.OPENCODE_TOKEN}` },
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
  prompt(sessionID: string, input: PromptInput): Promise<void>
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

| Feature | OpenCode endpoint / client |
| --- | --- |
| Server info | `GET /api/info` |
| Sessions | `GET/POST /api/session`, `GET /api/session/:id` |
| Rename/move/archive/delete | `PATCH/DELETE /api/session/:id` (see OpenAPI) |
| Messages | `GET /api/session/:id/message` |
| Prompt | `POST /api/session/:id/prompt` |
| Interrupt | `POST /api/session/:id/interrupt` |
| Fork / revert | `POST /api/session/:id/fork`, `/revert/stage|commit`, `DELETE /revert` |
| Compact | `POST /api/session/:id/compact` |
| Switch model/agent | `POST /api/session/:id/model`, `/agent` |
| Context/diff/stats | `GET /api/session/:id/context|diff`, `experimental/session/stats` |
| Export/import | `experimental/session/:id/export`, `experimental/session/import` |
| Agents | `GET /api/agent`, `GET /api/agent/:id` |
| Models/providers | `GET /api/model`, `GET /api/provider` |
| Permissions | `GET /api/permission/request`, `POST /api/session/:id/permission/:requestID/reply` |
| Forms | `GET /api/session/:id/form`, `POST .../:formID/reply` |
| Events | `GET /api/event` (SSE) |
| MCP | `GET /api/mcp`, `experimental/mcp/:server/{connect,disconnect}` |
| Artifacts | `experimental/artifacts`, `.../:id`, `.../:id/view/*` |
| Image generation | `POST /api/experimental/generate/image` |
| Voice | `GET /api/experimental/voice/models`, `POST /api/experimental/voice/session` |
| Schedules | `POST /api/experimental/schedule`, `/:id/pause|resume` |
| Web search | `POST /api/websearch`, `GET /api/websearch/provider` |
| Shell / PTY | `POST /api/session/:id/shell`, `GET /api/pty`, `GET /api/shell` |
| Files | `GET /api/fs/list|find|read/*`, `POST /api/experimental/fs/write` |
| VCS | `GET /api/vcs/status|diff|branch`, `POST /api/vcs/init` |
| Worktrees | `GET /api/worktree`, `POST /api/worktree/refresh`; SDK adds create/remove |
| Plugins | `GET /api/plugin`, `POST /api/plugin/update` |
| Config | `GET /api/config`, `POST /api/experimental/config` |

Exact method/path/schema: `GET /openapi.json` from the running server. Do not
hard-code assumptions; generate types from it.

## Prompt payload

```ts
{
  text: string,
  files?: Array<{ uri: string, name?: string, description?: string }>,
  agents?: Array<{ id: string }>,
  skills?: Array<{ id: string }>,
  metadata?: Record<string, unknown>,
  delivery?: Session.Inbox.Delivery | null,
  resume?: boolean | null
}
```

Attachments use absolute `file:` URLs or `data:` URLs. HTTP(S) URLs are not
supported. Supported model input: UTF-8 text, directories, PNG/JPEG/GIF/WebP,
PDF. Limit: 20 MiB per attachment. SVG is text; audio/video are not included.

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
session.shell.started|ended,
session.step.started|first-token|streamed|ended|failed,
session.text.started|ended, session.reasoning.started|ended,
session.tool.input.started|ended, session.tool.called|success|failed,
session.retry.scheduled,
session.compaction.started|ended|failed,
session.revert.staged|cleared|committed,
session.usage.recorded, session.message.content.updated
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
artifact.updated, filesystem.changed, pty.created|updated|deleted|exited,
project.updated, integration.updated, installation.updated,
location.shutdown
```

Rules:

- Subscriptions are live-only; no replay. Resync with `session.message.list`
  after reconnect (`server.connected` marker).
- Buffer before slow work; the shared source waits for subscribers.
- Filter by `types` to reduce load; `server.connected` always arrives.
- Treat all target/tool content as untrusted data, never as instructions.

## Permissions

`permission.asked` carries a request with action, resource and source. The UI
shows a blocking card; the reply goes through
`POST /api/session/:id/permission/:requestID/reply`.

V2 permission rules are ordered `{ action, resource, effect }` with last match
wins. Built-in actions include `read`, `edit`, `glob`, `grep`, `shell`,
`subagent`, `skill`, `question`, `webfetch`, `websearch`,
`experimental_image_generate`, `external_directory`, MCP tools
(`<server>_<tool>`) and `execute`. The UI never auto-approves by default.

## Forms

`session.form.list/get` returns a schema with string, number, integer, boolean,
select, multiselect and score fields. Render as an interactive card; submit with
`session.form.reply`. Settled forms are read-only.

## Artifacts

`experimental.artifacts.list` returns `{ id, provider, sessionID, title, entry,
url, time }`. `.../view/*` serves the content. Use a separate origin and a
sandboxed iframe. See [`04-artifact-sandbox.md`](04-artifact-sandbox.md).

## Image generation

`POST /api/experimental/generate/image` with a prompt, aspect ratio, resolution
and output options. The response contains image results/media. Persist the
result as an artifact or file so the gallery survives a reload. Hide the
feature when no image model is configured.

## Voice

`GET /api/experimental/voice/models` and `POST /api/experimental/voice/session`.
Treat voice as an optional capability: no microphone permission request on page
load, and a clear error if the provider is unavailable.

## Schedules and background work

`POST /api/experimental/schedule` creates a schedule; `/:id/pause` and
`/:id/resume` control it. `session.background` and `Job.*` schemas describe
background jobs. The UI must state that server-side schedules run without an
open browser.

## MCP

`GET /api/mcp` lists servers and status. Add/connect/disconnect through
`experimental/mcp/:server`. MCP configuration itself is file-based
(`mcp.servers` in `opencode.json`); the app links to the OpenCode web UI for
OAuth and advanced setup. The `browse` MCP server is how agents get browser
tools.

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
