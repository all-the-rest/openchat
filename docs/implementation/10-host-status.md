# 10 — Host status: the app is up, the host is not

**Status:** 2026-11-18. Implements the chat-side half of issue #20 (milestone
v2.0). The deployment half stays in #9.

Spec: [`../spec/13-code-surface.md`](../spec/13-code-surface.md). Architecture:
[`../architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md).

## Two states

The BFF never starts an OpenCode service; it only talks to `OPENCODE_URL`
([`04-remote-host.md`](04-remote-host.md)). That URL may point at a private
address or a forwarded port behind an SSH reverse tunnel, so a dead tunnel is a
normal operating state rather than a bug.

| State | `host.reachable` | What the user sees |
| --- | --- | --- |
| `reachable` | `true` | The normal shell: sessions, models, agents, apps and Code. |
| `unreachable` | `false` | The shell plus one banner under the bar; send is disabled, drafts stay. |

The app answering `/api/info` at all proves the app is up. `server: null`,
empty `models` and empty `agents` therefore mean "the host behind the BFF did
not answer", never "the app is broken". This is why the contract carrier is
called `HostStatus` and sits next to `InfoResponse`, not in a separate health
endpoint.

## Where the flag comes from

`GET /api/info` settles its three host calls independently:

```ts
const [info, models, agents] = await Promise.allSettled([
  backend.info(),
  backend.listModels(),
  backend.listAgents(),
])
```

- `host.reachable` is true when **at least one** call fulfilled. A host that
  answers one call is up; a partial failure keeps what worked.
- `server` is the fulfilled `info()` value or `null`.
- `models` and `agents` are the fulfilled lists or `[]`.
- `code` and `apps` keep their own probes. They already degrade on their own
  (`apps.available` false, `code.configured` from configuration), so a dead
  host cannot hide them either.

Response shape delta:

```ts
interface HostStatus { reachable: boolean }

interface InfoResponse {
  host: HostStatus        // new
  server: ServerInfo | null  // was: ServerInfo
  // models, agents, scenario, dictation, code, apps unchanged
}
```

Before this slice the route awaited `Promise.all` over the same three calls, so
any host failure became `500 internal_error`; the client could only treat that
as "not configured" (the flags stayed hidden) and the session list showed its
own generic error, with nothing saying the host was down. `/api/info` now
always answers `200`, with `Cache-Control: no-store`, and never copies upstream
error text into the body. There is no new health
endpoint and nothing polls: the provider reads `/api/info` once at boot and
again only when the user retries.

## What the banner does

`HostStatusBanner` lives in the shell (`AppShell`), directly under the app bar,
so it appears on every protected route — chat, search, apps and code. It is a
`role="status"` / `aria-live="polite"` region: it does not take focus, does not
interrupt a screen reader, and has no dismiss control because the condition is
still true.

- **Headline** — the app is running, the host is not (`host.unreachable`).
- **Hint** — the OpenCode host did not answer; retry when the tunnel is back
  (`host.unreachableHint`).
- **Retry** — calls `SurfaceProvider.refresh()`, which re-reads `/api/info`
  once. It is the only action, and it is user-triggered.

The session list keeps its own Retry from the sessions provider; the two are
deliberately not coupled.

## What the composer does

While `hostReachable === false`:

- the send button is disabled and points at the banner as its accessible
  description;
- Enter no longer submits; it edits the draft as a newline;
- the textarea stays enabled and the draft stays in memory and in
  `sessionStorage`, so a temporary outage never loses the prompt;
- no second error is shown — the banner is the explanation.

After a reachable retry the send control re-enables with the same draft.

A failed `/api/info` request (BFF or auth problem) also sets
`hostReachable: false`, matching the existing "failed info means not
configured" rule. `BootError` is unchanged: a BFF/auth failure is still a boot
failure, not a host state.

## Shared-service proof

`apps/server/test/no-spawn.test.ts` reads every `.ts` file under
`apps/server/src` and `packages/opencode/src` and fails when one contains
`child_process`, `spawn(`, `execFile(`, `execa` or `opencode serve`. It uses
`import.meta.dirname`-relative paths, so the working directory does not matter,
and the failure names the offending file.

The reason is parity with `opencode-web-gate`: starting a second OpenCode
service reads the same SQLite database but has its own process-bound `running`
state, so a turn started in the TUI would never appear in the web stream. The
BFF therefore attaches to the one service at `OPENCODE_URL` and never starts
its own.

## Tests

| File | Covers |
| --- | --- |
| `apps/server/test/host-status.test.ts` | every call rejecting → `200`, `reachable: false`, `server: null`, empty lists, `code`/`apps` still answered, no upstream text; partial failure → `reachable: true` with empty models; healthy fake → reachable |
| `apps/server/test/no-spawn.test.ts` | the shared-service proof above |
| `apps/web/test/host-status.test.tsx` | banner absent when reachable, present on a protected route with `role="status"`, failed info counts as unreachable, retry re-reads and hides it, send blocked with the draft preserved and re-enabled afterwards |
| `packages/contracts/src/contracts.test.ts` | a dead host types without server info |

## Manual checks that remain manual

These were **not** run automatically; they need a real OpenCode service and a
real tunnel, which the test suite deliberately never starts or contacts:

1. **A TUI turn appears in the web stream.** Start one `opencode service`, open
   a session in the TUI, send a turn, and watch it in the web chat through the
   BFF's SSE stream. This is the behaviour the no-spawn test only proves by
   absence.
2. **The tunnel goes down and comes back.** With the app open, stop `autossh`
   or the forwarded port, reload: the banner appears, drafts survive, send is
   disabled. Restore the tunnel and press Retry: the banner disappears and the
   composer re-enables. The reachable fake proves the state machine, not the
   network path.

Both belong to the #9 deployment runbook when the composed stack exists.
