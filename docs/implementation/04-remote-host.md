# 04 — Remote OpenCode host (V2, FR-43)

**Status:** 2026-11-17. The BFF can talk to a Code host on another machine
without changing the browser contract: the page still opens one same-origin
SSE stream and one same-origin JSON API, and the credentials stay server-side.

## Topology

```
browser ──HTTPS──▶ Caddy ──▶ BFF :8787 ──private net / SSH tunnel──▶ opencode :4096
                                   │
                                   └── same-origin /api/events (SSE)
```

- `OPENCODE_URL` is the only switch. Supported shapes: a WireGuard/Tailscale
  address (`http://100.x.y.z:4096`) or a forwarded local port
  (`ssh -N -L 4096:127.0.0.1:4096 owner@host` → `http://127.0.0.1:4096`).
- The Code host proxy and the browser never get the remote address: the BFF is
  the only client, and `/api/info` carries no upstream URL or credential. It
  does expose `server.version`, models, agents, the fake scenario and the
  dictation state, all of which are product data.
- Port 4096 is never published. A reverse proxy in front of the BFF keeps
  response buffering off for `text/event-stream`.

## Boot validation

`loadEnv` (`apps/server/src/env.ts`) rejects a malformed `OPENCODE_URL`, a
non-http(s) scheme and embedded credentials (`http://user:pass@host`), then
normalises the value to a concrete origin plus path: no trailing slash, no
query, no fragment. Failing the boot is deliberate: falling back to
`127.0.0.1` would silently talk to the wrong host.

## Stream behaviour

| Property | Value |
| --- | --- |
| Content type | `text/event-stream` |
| Caching | `Cache-Control: no-cache, no-transform` |
| Proxy buffering | `X-Accel-Buffering: no` |
| Reconnect hint | `retry: 2000` as the first frame |
| Keepalive | `: heartbeat` every 15 s (`SSE_HEARTBEAT_MS`) |
| Client | one `EventSource`; reconnect counter resynchronizes state |

`apps/server/test/stream.test.ts` pins the headers and a keepalive frame by
injecting a 20 ms heartbeat interval; the production value stays 15 s.

## Smoke check

`apps/server/src/smoke.ts` performs the browser sequence over plain HTTP and is
tested against a stub server; `smoke-args.ts` parses flags and owns the exit
codes, so both stay under the 400-line cap. `smoke-cli.ts` is the entry point:

```bash
OPENCHAT_SMOKE_URL=https://chat.example.com \
OPENCHAT_PASSWORD=... \
OPENCODE_PASSWORD=... \
pnpm --filter @openchat/server run smoke:remote -- --heartbeat-ms 20000
```

It reports, with measured milliseconds:

1. `health` — `200`, `ok: true`, `mode: live` (unless `--allow-fake`).
2. `login` — `200`, session cookie with `HttpOnly` and `SameSite`, plus
   `Secure` when the target is `https:` (a deployment that runs
   `ALLOW_INSECURE_COOKIE=1` behind https therefore fails this check by
   design); when the deployment sets no cookie (`AUTH_MODE=basic`), the tool
   authenticates with `Authorization: Basic` using `--user`/`OPENCHAT_USER`
   (default `owner`).
3. `info` — `200`, `server.mode`, `server.workspace`, dictation state.
4. `events` — `200`, SSE headers (`no-transform`, `x-accel-buffering: no`),
   `retry: 2000`, and a heartbeat when `--heartbeat-ms` is large enough (the
   comment arrives every 15 s).
5. `no-secrets` — the four response bodies are scanned for
   `OPENCODE_PASSWORD` and `OPENCODE_URL`; `--forbid` adds more strings
   (`OPENCODE_URL` is normalised so a trailing slash still matches).

Every non-stream request has a 10 s deadline; the stream's headers use the
same deadline and its body is bounded by the stream/heartbeat window. A
half-open tunnel therefore fails with a `FAIL` line instead of hanging.

Exit code is `0` on pass, `1` on any failed check, `2` on a usage error
(missing URL/password, unknown flag, non-numeric window). The CLI never prints
the password. Prefer the environment over `--password`, which is visible in
shell history and `ps`, and avoid plain `http` to a non-loopback host (the tool
warns).

## Operations

- **Backups** run on the remote host: `opencode-data`, `opencode-config`,
  `workspace`, deployment `.env`. Snapshot before upgrades and test a restore.
- **Upgrades**: pin the image digest, back up, pull, restart, run the smoke
  check, keep the previous digest for rollback. A client/server version
  mismatch is a warning, not a migration.
- **Latency**: dominated by the tunnel round trip per request and per event.
  The smoke output is the baseline; a sudden increase points at the tunnel, not
  at the UI.
- **Failure shape**: a dead tunnel makes `/api/info` and every API call answer
  `500 internal_error`. `/healthz` is liveness-only and stays `200`; use
  `/api/info` as the upstream probe.
- **Path prefix**: `OPENCODE_URL` may carry a path (`https://host/opencode`);
  the SDK resolves `api/…` below it, and the boot strips only the trailing
  slash.

## Not covered

- No automated test opens a real remote host or a real tunnel; the smoke check
  is the acceptance tool and is run manually against the owner's deployment.
- WireGuard/Tailscale setup, firewall rules and the remote backup schedule stay
  host configuration, not application code.
- The Code surface itself (`apps/code-host`) is a separate slice (#11).
