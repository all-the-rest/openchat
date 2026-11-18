# 08 — Apps: MCP servers, skills and the connector gap

Status: v2 (issue #15). Spec: FR-24, FR-45, `02-information-architecture.md`
(`/apps`), `07-settings-auth.md` (Connectors). Contracts:
`packages/contracts/src/apps.ts`, re-exported from `index.ts`.

`/apps` answers one question: which MCP servers and skills does this workspace
have, and is each one actually connected? The answer comes from the host, never
from a cached client guess, and a server that failed stays visible with its
error instead of disappearing.

## What ships

| Capability | State |
| --- | --- |
| MCP servers with live status | yes — `mcp.list`, five states |
| Skills with description and `autoinvoke` | yes — `skill.list` |
| Connect / disconnect one server | yes — `experimental.mcp.connect` / `disconnect` |
| Hide the surface when the host cannot answer | yes — `/api/info` carries `apps.available` |
| App hits in search link to `/apps` | yes |
| Tools per server, running a tool | **no — the pinned client has no such API** |

### Why there is no tools section

`@opencode/client@2.3.0` exposes `mcp.list`, `mcp.resource.catalog`,
`skill.list` and `experimental.mcp.{add,remove,connect,disconnect,client.token}`
— there is no `tool` namespace at all (`grep -c tool dist/promise/client.d.ts`
→ 0). `contracts` records this: `SearchHit.appKind` allows `"tool"` but is
commented as reserved because the pinned client cannot list a server's tools.

Consequences, chosen deliberately:

- the page renders **no** tools section, no placeholder and no "coming soon";
- no endpoint exists that could run a tool, so nothing can be permission-gated
  because nothing can be invoked;
- a search hit can still carry `appKind: "tool"` if a future host sends one;
  the UI renders the existing kind label and nothing else.

Closing this needs an upstream API (a newer `@opencode/client`, its own spike,
and a re-pin). It is tracked on #15, not silently dropped.

## Files

```
packages/contracts/src/apps.ts         AppStatus, AppServer, AppSkill,
                                       AppsResponse, AppsSurfaceInfo
                                       (re-exported from index.ts)
packages/opencode/src/index.ts         AppsSnapshot + three port methods
packages/opencode/src/live-apps.ts     mcp.list + skill.list, one round
packages/opencode/src/fake-apps.ts     the fake's inventory + transitions
apps/server/src/apps-cache.ts          one 10 s snapshot for routes and /api/info
apps/server/src/apps.ts                /api/apps, connect, disconnect
apps/web/src/apps/*                    the /apps page
apps/web/src/api/client.ts             apps(), connectApp(), disconnectApp()
```

## Data

```ts
type AppStatus = "connected" | "pending" | "disabled" | "failed" | "needs_auth"

interface AppServer {
  name: string            // host-side identifier; the action's key
  title?: string          // display name when the host has one
  status: AppStatus
  error?: string          // only failed / needs_auth; already bounded
  integrationID?: string
}

interface AppSkill { id: string; name: string; description?: string; autoinvoke?: boolean }

interface AppsResponse { available: boolean; servers: AppServer[]; skills: AppSkill[] }
interface AppsSurfaceInfo { available: boolean }   // InfoResponse.apps
```

`needs_auth` keeps the host's spelling; the UI localises it from one status
vocabulary (`apps/web/src/search/sources.ts`, `STATUS_LABEL`) so search and
`/apps` cannot drift apart.

## Host port

- `listApps()` reads `mcp.list` and `skill.list` with `Promise.allSettled`: one
  failing list must not hide the other. Only when **both** fail does the call
  throw, because only then is the capability unanswerable.
- A server error string is bounded to 300 characters, control characters are
  replaced and whitespace collapsed. A stack trace never becomes a row.
- Skills are trimmed to `id`, `name`, `description`, `autoinvoke`. `path` and
  `content` stay upstream: they are workspace-local and can be large.
- `connectApp(name)` / `disconnectApp(name)` call
  `experimental.mcp.connect` / `disconnect` with the workspace directory. Any
  rejection becomes a fixed `BackendError`; the upstream message (which may
  carry a URL, a token or a path) is never forwarded.
- The fake keeps one inventory and derives its `apps` search hits from it, so a
  connect/disconnect shows up in search and in `/apps` in the same run. It can
  simulate a host without the surface (`appsAvailable: false`).

## BFF

| Route | Behaviour |
| --- | --- |
| `GET /api/apps` | `AppsResponse`, `Cache-Control: no-store`. `502 apps_unavailable` when the host cannot answer. |
| `POST /api/apps/:name/connect` | `204`, then the snapshot is invalidated so the next read is the host's new state. |
| `POST /api/apps/:name/disconnect` | same. |
| `GET /api/info` | `apps.available`, from the same cache; the probe never throws, so an unreachable host still boots. |

**One probe per window.** `AppsCache` holds the snapshot for 10 s (injectable
clock and TTL) and is shared by `/api/apps` and `/api/info`, so a page load does
not ask the host twice and a polling UI cannot hammer it. A completed answer —
including "this host has no such surface" — is cached; a *failure* is not, so a
transient outage does not pin a 502 for the whole window.

**Action guards**, in order:

1. throttle: 10 connect/disconnect calls per address in a 60 s fixed window,
   `429` with `Retry-After`. Every attempt counts, including an unknown name —
   the budget exists so the route cannot be used as an amplifier.
2. name shape: `^[A-Za-z0-9._-]{1,64}$` before anything reaches the host.
3. the name must be present in the current snapshot: a caller cannot pass an
   arbitrary string through to `experimental.mcp`, which is the "no wildcard
   proxy" rule in practice.
4. the action's `BackendError` code decides the response, never the upstream
   text:

| Backend code | HTTP | Code |
| --- | --- | --- |
| `conflict` (server is `disabled` in the host config) | `409` | `apps_disabled` |
| `not_found` (host dropped it between snapshot and action) | `404` | `apps_unknown_server` |
| `invalid` | `400` | `apps_invalid_name` |
| `unsupported`, `unavailable`, anything else | `502` | `apps_unavailable` |

## The `/apps` page

- The navigation entry appears only when `/api/info` says `apps.available`. A
  direct visit to `/apps` on a host without the surface redirects to `/`, the
  same rule `/code` follows for an unconfigured Code host.
- Two `section`s: **Servers** and **Skills**.
  - `connected` / `pending` → Disconnect.
  - `failed` / `needs_auth` → Connect (a reconnect is what the user wants).
  - `disabled` → no action, with the note that the host configuration owns it.
  - Every action's accessible name carries the server name; the button is
    disabled while its request runs.
- After an action the page re-reads `GET /api/apps` — the endpoint answers
  `204`, and the row must show what the host reports, not an optimistic guess.
- Failures are code-specific and never print upstream text: unknown server
  (gone from the config), disabled (host config), throttled (try again
  shortly), unavailable (the host did not answer).
- Skills show name, description and an `Auto` badge for `autoinvoke`; there is
  nothing to connect.
- States: loading, failed with Retry, and independent empty states for servers
  and skills. An unavailable answer that appears after `/api/info` already said
  yes renders the unavailable notice instead of an empty page.

## Search

`app` hits used to be informational text. A hit now links to `/apps`, keeps its
kind (`server` / `skill`) and its localised status, and does not fetch anything
of its own.

## Security

- No upstream error text, server names from the config, URLs or tokens reach the
  client: every failure is a fixed message with a stable code.
- The name must exist in the snapshot, so the route cannot be turned into a
  generic MCP call proxy.
- Connect/disconnect are `POST` with a JSON body, so the existing cross-origin
  guard and content-type check apply before the route runs.
- All `/api/*` routes sit behind the session cookie; there is no anonymous
  variant, and no admin proxy is involved (that is `ADMIN_PROXY` in spec 07,
  which is not implemented).

## Showing the absent surface

`FAKE_APPS=off` (fake backend only) makes the host answer as one without the app
surface: `/api/info` reports `apps.available: false` and `GET /api/apps`
answers `200 { available: false, servers: [], skills: [] }` — a deployment
fact, not a 502. A live host has no separate "unsupported" signal: when both
list calls reject, `/api/apps` answers `502 apps_unavailable` and `/api/info`
reports `apps.available: false` because its probe swallows the failure. So the
fake's switch is the only way to produce the honest `200` today, and a live
deployment without the surface looks like an outage until a host-side
capability flag exists. Reaching the hidden state in a browser needs a second
BFF started with `FAKE_APPS=off`; the E2E suite does not do that (see
End-to-end coverage).

## Known limitations

- **No tools** — see above; the pinned client cannot list or run them.
- **`available` follows the probe.** A host outage makes `/api/info` report
  `apps.available: false`, so the navigation entry disappears until the host
  answers again. That is the honest state (the page would otherwise show an
  error), but it means a transient tunnel drop hides the surface.
- **`disabled` is read-only.** Enabling a disabled server is host configuration
  (`opencode.json`); the app does not rewrite it.
- **No live push.** Status changes made in the TUI or by another client appear
  on the next read (page load, Retry, or after an action), bounded by the 10 s
  cache. The host does emit `mcp.status.changed`; wiring it into the event
  stream is a follow-up, not part of this slice.
- **One page per workspace.** `location.directory` is the BFF's
  `WORKSPACE_DIR`; there is no workspace switcher.

## Tests

- contracts: status tuple.
- `packages/opencode`: every MCP status mapped, `allSettled` partial failure,
  error truncation and control-character stripping, skills without
  `path`/`content`, connect/disconnect calling the right method with the
  workspace, empty-name rejection, fake determinism and the connect →
  `connected` / disconnect → `pending` transitions, unavailable inventory
  throwing.
- `apps/server`: `/api/apps` shape and auth, cache (two calls in the window →
  one probe), `available: false`, 502 without upstream text, connect/disconnect
  + invalidation, unknown name 404, invalid name 400, disabled 409, cross-origin
  POST 403, throttle 429 with `Retry-After`, `/api/info` sharing the probe.
- `apps/web`: five statuses and their actions, connect/disconnect with refetch,
  code-specific failures, skills with the Auto badge, empty states, loading,
  failed list with Retry, unavailable redirect, nav gating, search hit link,
  accessible action names.

## End-to-end coverage

`apps/web/e2e/apps.spec.ts` runs against the fake backend and proves, in a
browser:

- the sidebar's `nav-apps` entry opens `/apps`, the page lists all five fixture
  servers with the status text each one has (`connected`, `needs_auth`,
  `failed`, `disabled`, `pending`) and the two bounded error strings on the
  failing rows, `notes` has no action button and shows the disabled note, and the
  skills section shows both skills with the `Auto` badge on the autoinvoking one
  and no action;
- connect and disconnect follow the host: `github` goes `needs_auth` →
  `connected` (Connect turns into Disconnect) → `pending` after Disconnect. The
  change is asserted on the row, not as a global count, and it comes from the
  re-read after the 204 rather than from an optimistic client guess;
- a failing action keeps the row: a `502 apps_unavailable` for `postgres` renders
  "The host did not answer.", the row and its Connect button stay, and an
  upstream string carried in the error body never appears anywhere in the DOM;
- a deep link to `/apps` lands on the page inside the app shell, with the
  sidebar present and the entry marked `aria-current="page"`.

The inventory is the fake's fixture (`packages/opencode/src/fake-apps.ts`): no
real MCP server is contacted and no credential is involved. That inventory is
process-wide while Playwright runs four workers, so the two tests that read or
change it run in `describe.serial`, and each test presents its own
`X-Forwarded-For` to stay inside the per-address action throttle.

**The hidden state is unit-tested only.** The E2E BFF starts once with
`FAKE_APPS=on` and the Vite dev server proxies to that one process, so a second
deployment with `FAKE_APPS=off` is not reachable from the same run. The
`available: false` behaviour — no navigation entry, the redirect away from
`/apps`, the unavailable notice — is pinned by unit tests only
(`apps/web/test/apps-page.test.tsx`, `apps/server/test/apps.test.ts`, and the
fake's own tests), not by a browser test. The same holds for loading, the failed
list and Retry, which the browser suite does not make wait on a stalled read.

## Not in scope

Running tools, tool permissions, OAuth for `needs_auth` servers (that stays in
OpenCode's own UI / the Code surface), editing server configuration, and
multiple workspaces.
