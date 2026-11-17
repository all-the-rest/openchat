# 01 — System Architecture

## Context

```
┌──────────┐      HTTPS       ┌──────────────┐      HTTP/SSE      ┌──────────────┐
│ Browser  │ ───────────────▶ │  BFF + Web   │ ─────────────────▶ │   OpenCode   │
│ (React)  │ ◀─────────────── │  (Bun/Hono)  │ ◀───────────────── │   (2.3)      │
└──────────┘   same-origin    └──────────────┘   localhost only   └──────┬───────┘
                                                                          │
                                              ┌───────────────────────────┼───────────────────────┐
                                              ▼                           ▼                       ▼
                                        Model providers              MCP servers           Workspace / git
                                        (self-hosted/API)          (browse, rea, …)        (files, worktrees)
```

The browser never talks to OpenCode directly. The BFF owns authentication and
proxies the OpenCode API and event stream on the same origin.

## Components

| Component | Responsibility |
| --- | --- |
| `apps/web` | React UI, rendering registry, composer, transcript, settings |
| `apps/server` | Bun/Hono BFF: auth, session cookie, same-origin proxy, static files |
| `apps/artifact-host` | Separate origin for sandboxed agent artifacts |
| `packages/opencode` | Typed adapter around `@opencode/client` (and later `@opencode/sdk`) |
| `packages/contracts` | Shared types, event normalization, error shapes |
| `packages/ui` | Design system components and tokens |

## Integration options

| Option | Description | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| **A. BFF + OpenCode server** | `opencode serve` as a separate process; BFF uses `@opencode/client` | Official web UI available; process isolation; simple upgrades; CORS solved by proxy; can run on a VPS | Two processes; localhost hop | **Default for v1** |
| **B. Embedded SDK** | `@opencode/sdk` hosts OpenCode inside the Bun BFF | Single process; no network hop; plugin transforms; tight integration | No official web UI; experimental surface; lifecycle/cleanup; harder upgrades | **Spike, adapter behind the same port** |
| **C. Fork OpenCode web UI** | Extend the official UI | Fast start; native features | Coupled to upstream; hard to make ChatGPT-like; auth/UX constraints | Rejected |
| **D. Static client** | Browser talks directly to OpenCode (like `opencode-pwa`) | No backend | CORS, auth, secret exposure, no same-origin, no artifact host | Rejected for this product |

## Recommended path

1. Build v1 on **A**.
2. Define a `ChatBackend` port in `packages/opencode` with two adapters:
   `HttpOpenCodeBackend` (client) and `EmbeddedOpenCodeBackend` (SDK).
3. Ship A. Keep B as an experimental mode for single-process deployments once
   the SDK surface is stable enough.
4. Re-evaluate after the first working chat if the localhost hop or the second
   process becomes a real problem.

## Data flows

### Prompt and stream

1. Browser posts to `/api/chat/:sessionId/prompt` (same origin, session cookie).
2. BFF validates auth, CSRF and payload, then calls OpenCode
   `session.prompt`.
3. BFF subscribes to `/api/event` and forwards normalized events over SSE
   (`/api/events`).
4. Browser folds deltas into the transcript.
5. On completion, the browser reconciles with `session.message.list`.

### Permission

1. OpenCode emits `permission.asked`.
2. BFF forwards it; the UI blocks the affected tool card.
3. User chooses allow/deny.
4. BFF calls `session.permission.reply`; OpenCode resumes.

### Artifact

1. OpenCode writes an artifact (provider, entry, URL).
2. UI requests `/api/artifacts/:id` from the BFF.
3. BFF returns metadata and a signed artifact URL on the artifact origin.
4. The artifact origin serves the content with a restrictive CSP; the UI embeds
   it in a sandboxed iframe without `allow-same-origin`.

## Repository layout

```
apps/
  web/                 React + Vite
  server/              Bun + Hono BFF
  artifact-host/       static artifact origin
packages/
  contracts/           shared types and event normalization
  opencode/            backend adapters
  ui/                  design system
docs/
  clean-room/          observation (builder cannot read)
  spec/                specification (builder reads)
  architecture/        decisions
  matrix/              feasibility
  decisions/           ADRs
features/              product scope and acceptance
```

## Failure modes

| Failure | Behavior |
| --- | --- |
| OpenCode down | BFF returns 503; UI shows a reconnect banner; drafts preserved |
| Event stream drops | Client reconnects with backoff; resyncs messages |
| Provider error | Structured error card; retry available |
| BFF restart | Session cookie survives; UI reloads state from OpenCode |
| Artifact origin down | Artifact panel shows an error; chat continues |
| Disk full | Uploads rejected; clear error; no partial state |

## Observability

- Structured logs (JSON) with request ID, route, status, latency.
- No prompt or attachment content in logs by default.
- Metrics: request rate, error rate, stream duration, first-token latency.
- Health endpoint: `/healthz` checks BFF and OpenCode.
- Optional OpenTelemetry later.
