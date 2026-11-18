# 14 — Deployment: compose stack, tool runtime, cutover

**Status:** 2026-11-18. Implements the deployment half of issue #20: images,
`compose.yaml`, the agent tool runtime, resource guards, the atomic swap and the
cutover note. Architecture: [`../architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md).
Parity source: [`../research/opencode-web-gate-parity.md`](../research/opencode-web-gate-parity.md) gaps 3–7.

Nothing in this slice was executed against a Docker daemon: no image was built
and no container was started. Everything below is validated statically — by the
`deploy/` invariant tests, by bundling the three entry points with the same
esbuild command the Dockerfiles use, and by running the bundles directly with
`node`. The manual acceptance steps are listed at the end.

## What ships

| Piece | Path | What it is |
| --- | --- | --- |
| BFF image | `deploy/Dockerfile.bff` | BFF + built SPA on one origin; the only application port |
| Code host image | `deploy/Dockerfile.code-host` | OpenCode UI proxy on `code.<domain>` |
| Artifact host image | `deploy/Dockerfile.artifact-host` | read-only byte server on `artifacts.<domain>` |
| Tool runtime | `deploy/code-host/tools.Dockerfile` | git, gh, ripgrep, node/pnpm, Docker CLI for agent work |
| Stack | `compose.yaml` | one project, six services, profiles for the optional three |
| Swap | `deploy/swap.sh` | candidate validation, link swap, rollback, `--dry-run` |
| Env template | `deploy/env.example` | host-only `.env` skeleton, every secret empty |
| Static serving | `apps/server/src/static.ts` | the production entry point for `apps/web/dist` |

A bucket, in order of who may reach whom:

```
internet ──TLS──▶ edge proxy (owner's Caddy, not in this file)
                    ├── bff:8787            chat.<domain>          session cookie
                    ├── code-host:8090      code.<domain>          ticket → own cookie
                    └── artifact-host:4100  artifacts.<domain>     no cookie, signed URL
                          artifacts volume (ro)
bff ──backend──▶ opencode:4096              never published, Basic auth
bff/code-host/toolbox ──backend──▶ …
toolbox ──dind──▶ rootless dockerd:2375     profile only, internal network
```

## Why the BFF serves the SPA

`apps/server/src/index.ts` never served static files before this slice: in
development Vite does. A single-origin deployment needs one process for both, so
`static.ts` adds the smallest production entry point that was missing:

- `WEB_DIST_DIR` names the build directory. Unset (development, tests) the
  module is inert and the request goes straight to the API app.
- `GET`/`HEAD` only. `/api/*` and `/healthz` are never resolved against the
  filesystem, so a file cannot shadow a route. The reserved check reads the
  first path segment case-insensitively and ignores repeated leading slashes
  (`/API/info`, `//api/info`, `/healthz/`); the filesystem lookup below still
  uses the exact decoded path.
- `/assets/*` is cached `public, max-age=31536000, immutable` (content-hashed
  names); the shell is `no-store`, so a deploy is visible on the next load.
- A missing path with an extension is a 404, not the shell: an absent
  `/assets/app.js` must not answer `index.html`. Routes without an extension get
  the shell.
- Traversal is normalised and prefix-checked against the build directory;
  percent-encoded `..`, NUL bytes and malformed escapes fall through to the app.

`apps/server/test/static.test.ts` pins all of it. The shell stays public on
purpose: the login page is part of the SPA and every `/api/*` route enforces the
session.

## Images

All three application images share one shape:

```dockerfile
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92…   # pinned by digest
FROM ${NODE_IMAGE} AS build      # pnpm install --frozen-lockfile --filter <pkg>…
FROM ${NODE_IMAGE} AS runtime    # tini, USER node, HEALTHCHECK
```

- **Base pin.** The digest pins the multi-arch index of `node:24-bookworm-slim`
  as published on 2026-11-18. The tag stays in the `ARG` so a bump is one line;
  a rebuild without an intentional digest change is not possible.
- **Install subset.** `pnpm install --frozen-lockfile --filter @openchat/server...
  --filter @openchat/web...` (and the corresponding single filter for the other
  two) installs the package, its workspace dependencies and nothing else. A
  lockfile/manifest drift fails the build instead of resolving silently.
- **No dev dependencies in the runtime layer.** `build:image` bundles
  `src/index.ts` with esbuild into one ESM file, so the runtime stage contains no
  `node_modules` at all — not a pruned tree, none. The invariant test asserts the
  runtime stage contains no install command.
- **Signals.** `tini` is PID 1 and the entry point is exec-form, so `docker stop`
  reaches Node as SIGTERM and the SSE streams close instead of the process being
  killed after the grace period.
- **Non-root.** `USER node` (uid 1000) in every image. The BFF's `/artifacts`
  directory is created with that owner, so Docker initialises a fresh named
  volume with the same ownership.
- **Healthchecks.** BFF `/healthz` (liveness only — it stays 200 while OpenCode
  is down, per [`10-host-status.md`](10-host-status.md)); Code host `/__sign-in`
  (the anonymous liveness reach; `/__health` needs the upstream and would flap);
  artifact host `/healthz`.

The Code host and the artifact host are `read_only` with a `/tmp` tmpfs. The BFF
is too, but mounts the artifact volume read-write; that volume is its only
writable path.

## Compose stack

`compose.yaml` is one project (`openchat`), one network per trust boundary:

| Network | Members | Property |
| --- | --- | --- |
| `edge` | bff, code-host, artifact-host, edge proxy | the proxy's network; nothing else publishes |
| `backend` | bff, code-host, toolbox, opencode | has egress (OpenCode needs model providers) |
| `artifacts` | bff, artifact-host | `internal: true` — no default route |
| `dind` | toolbox, dind | `internal: true` |

- **Published ports: two.** `127.0.0.1:${BFF_PORT}:8787` and
  `127.0.0.1:${ARTIFACT_PORT}:4100`, both loopback so the edge proxy is the TLS
  terminus. The artifact origin is the second public origin on purpose: a
  cross-origin iframe cannot send credentials, so the document is authorized by
  the signed URL alone (`?exp=…&sig=…`), the host sets no cookie, has no CORS
  header, no redirect and no write path, and carries its own CSP with
  `frame-ancestors <chat origin>`. Making it credential-bearing would break the
  design; making it unreachable would remove artifacts.
- **`TRUST_PROXY` is off by default.** The BFF's published port is on host
  loopback, where any local process can send its own `X-Forwarded-For`; trusting
  that header would let it rotate its throttle bucket on every request
  ([`11-proxy-addressing.md`](11-proxy-addressing.md)). When the edge proxy is
  the only path to the port and appends (or overwrites) the header, set
  `TRUST_PROXY=1` in `.env`; `deploy/env.example` ships `0`.
- **OpenCode has no `ports:` entry and no `edge` membership.** The BFF and the
  Code host reach `opencode:4096` on `backend` with the Basic credential.
- **`OPENCODE_URL` is never published.** The compose default is
  `http://opencode:4096`; an owner pointing at a remote host sets it in `.env`
  and leaves the `opencode` profile off.
- **Artifact volume.** `artifacts:/artifacts` read-write in the BFF only;
  `artifacts:/artifacts:ro` in the artifact host. An invariant test asserts the
  writer set is exactly `{bff}`.
- **Profiles.** `opencode` (local service), `tools` (toolbox), `dind` (rootless
  daemon). A plain `docker compose up -d` starts only bff, code-host and
  artifact-host.

### Upper bounds

Every service carries `mem_limit`, `mem_reservation`, `cpus`, `pids_limit`,
`restart: unless-stopped` and a rotating `json-file` log (10–20 MiB × 3 files):

| Service | Memory | Pids | CPUs |
| --- | --- | --- | --- |
| bff | 768 MiB (reserve 256) | 256 | 1.5 |
| code-host | 384 MiB (reserve 128) | 192 | 1.0 |
| artifact-host | 256 MiB (reserve 64) | 128 | 0.5 |
| opencode | 4 GiB (reserve 1 GiB) | 2048 | 2.0 |
| toolbox | 2 GiB (reserve 512 MiB) | 512 | 2.0 |
| dind | 4 GiB (reserve 2 GiB) | 1024 | 2.0 |

These are Compose v2 service attributes (`docker compose up` honours them, no
Swarm needed). They cap a runaway process; they do not replace a host quota.

## Agent tool runtime

The OpenCode shell tool can need Docker for build-and-test workflows. That is a
separate concern from the application images, and it is why the stack has two
optional services rather than one bigger BFF:

- **`toolbox`** (`deploy/code-host/tools.Dockerfile`, profile `tools`): Debian
  bookworm slim with git, gh, ripgrep, jq, sqlite3, Node 24 and pnpm 11, plus the
  **Docker CLI only** (static release tarball, no daemon, no containerd). It runs
  as `node`, shares the workspace volume and is capped at 2 GiB / 512 pids.
- **`dind`** (profile `dind`): `docker:27-dind-rootless` on the internal `dind`
  network, 4 GiB / 1024 pids. Rootless, so it is **not** privileged; the only
  relaxed setting is `seccomp=unconfined` + `apparmor=unconfined`, which user
  namespaces need. It publishes nothing and has no edge member.

Both profiles are off by default. `docker compose --profile tools --profile dind
up -d toolbox dind` gives an agent a Docker-capable shell; without `dind`, the
CLI fails with a connection error instead of quietly reaching the host daemon.

Host prerequisites for rootless dind (owner work, not compose): unprivileged
user namespaces enabled (`newuidmap`/`newgidmap` present, `kernel.unprivileged_userns_clone=1`
on kernels that still gate it) and `fs.inotify.max_user_instances` raised, which
Docker's own rootless documentation requires.

The tool image is deliberately **not** the application image: it has a shell on
purpose. Do not attach the BFF or the artifact host to `dind`.

## Deploy safety

`deploy/swap.sh` implements the candidate→validate→swap→rollback pattern the
predecessor used, without its secret handling:

```bash
# on the host, from the stack root (/opt/stacks/openchat)
install -m 600 deploy/env.example .env        # once; fill in the secrets
deploy/swap.sh --release releases/2026-11-18 --prepare build --dry-run
deploy/swap.sh --release releases/2026-11-18 --prepare build --expect-version 0.1.0
```

Layout and behaviour:

```
$STACK_DIR/
  .env                          host-only, 0600, never committed
  releases/<name>/compose.yaml  one candidate
  current  -> releases/<name>   what compose runs
  previous -> releases/<name>   what ran before `current`
```

1. `docker compose … config -q` on the candidate — a malformed file fails before
   any link moves.
2. Optional `pull`/`build` of the candidate images.
3. `current` points at the candidate, then `up -d --wait` reconciles the stack.
4. Validation: `/healthz` must answer `200 {"ok":true}` within `--timeout`, then
   `/api/info` must answer `200` or `401`. The probe sends no credential: `401`
   proves the route exists and the session guard runs, which is what a deploy
   needs to know; `5xx`, `404` and a dead socket fail the candidate. With `200`
   a degraded host is allowed — OpenCode being unreachable yields `200` with
   `host.reachable: false` and is not a failed deploy
   ([`10-host-status.md`](10-host-status.md)). `--expect-version` adds a
   `/healthz` version check for a client/server skew check.
5. On any failure the script restores `current` to the previous release and
   recreates it, then re-validates; a failed rollback exits non-zero with a
   message that names the host, not a secret.
6. On success `previous` records the release that just stopped running.

Idempotent: a rerun against the release `current` already points at validates
once and changes nothing (no compose invocation, no link move).
`--dry-run` prints every step (`would: …`) and touches no file, no image and no
container. `.env` reaches compose only through `--env-file`; the script has no
secret argument and never prints a value.

Exit codes: `0` swapped or validated no-op, `1` validation/rollback failure,
`2` usage error.

## Resource guards

What the stack configures (all in `compose.yaml`):

- **Memory.** `mem_limit` + `mem_reservation` per service (table above). Exceeding
  `mem_limit` OOM-kills the container and `restart: unless-stopped` brings it
  back; the reservation is the soft floor Compose/Swarm uses for placement.
- **Pids.** `pids_limit` per service caps fork bombs and runaway build jobs.
- **CPU.** `cpus` per service; no service can starve the BFF.
- **Disk (artifacts).** A named volume is **not** size-limited by Compose. The
  quota belongs to the host: an ext4/XFS project quota (`prjquota`) on the
  volume's directory, or a separate small LVM/XFS volume. Budget from the
  contract: 1 MiB per document, 20 creations per minute per client
  ([`09-artifacts.md`](09-artifacts.md)); a 2 GiB quota holds ~2000 maximal
  documents. Exceeding it fails the write with `500 internal_error` and the BFF
  keeps serving reads.
- **Logs.** `json-file` with `max-size` 10–20 MiB and `max-file: 3` per service,
  so a log flood costs at most ~60 MiB per container and cannot fill the disk.
- **Read-only filesystems.** bff, code-host and artifact-host; tmpfs for `/tmp`.

What Compose **cannot** do — owner/host work, stated plainly:

| Concern | Inside compose | Owner must do on the host |
| --- | --- | --- |
| RAM watchdog | A `mem_limit` kills one container; nothing watches host-level pressure | A systemd unit (`MemoryHigh`/`MemoryMax`, `Restart=on-failure`) around the stack, or a cron watchdog that reads `MemAvailable` and stops the `opencode` service below a threshold. Compose has no supervisor and cannot restart a whole stack on host pressure. |
| Total stack ceiling | Per-container only | `systemd` slice accounting for the docker service, or the VPS size. |
| Swap / overcommit | Not configured here | `vm.swappiness`, `vm.overcommit_memory`; decide whether the agent may swap. |
| Disk quota for the artifact volume | Not expressible for a named volume | XFS project quota, ext4 `prjquota`, or a dedicated volume; monitor free space. |
| dind image garbage | Nothing collects images | Scheduled `docker image prune` **inside** the rootless daemon (`DOCKER_HOST=tcp://dind:2375`), bounded to under the 4 GiB limit. |
| Kernel OOM score | Not expressible | `oom_score_adj` via the systemd unit if the BFF must survive the agent. |
| Backups | Not in this file | `opencode-data`, `opencode-config`, `workspace`, the artifact volume and `.env`; test a restore. |

The predecessor kept `ram-watchdog.sh` and `dind-guard.sh` as host scripts. They
stay host scripts: a container that watches its own cgroup cannot enforce a host
policy, and Compose has no hook that runs when the host runs out of memory.

## Cutover

Domains (the only place hostnames are configured — `deploy/env.example`):

| Origin | Serves | Cookie |
| --- | --- | --- |
| `https://chat.<domain>` | BFF + SPA + `/api/*` + `/code` switch | session |
| `https://code.<domain>` | OpenCode UI proxy | own auth cookie |
| `https://artifacts.<domain>` | signed document bytes | none |

Cookie rules (they are the reason the three origins stay separate):

- **App session.** `__Host-oc_session` when `COOKIE_SECURE=1` (the `__Host-`
  prefix makes a `Domain` attribute invalid to the browser; development keeps
  `oc_session`), `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`,
  **no `Domain` attribute** — host-only, so it is never sent to the code or
  artifact origin, and never to a sibling subdomain.
- **Code host session.** `__Host-oc_code` (the `__Host-` prefix makes a `Domain`
  attribute invalid to the browser) with the same `HttpOnly`/`Secure`/
  `SameSite=Lax` shape. It is minted only by the single-use ticket exchange
  (`/__auth?ticket=…`), never by the app.
- **Artifact origin.** No `Set-Cookie` at all, in any route — asserted in
  `apps/artifact-host/test/app.test.ts`. Authorization is the signature in the
  URL, which is why it may be public and cookie-less.

Order of operations (each step starts from the previous one working):

1. **DNS.** Point `chat`, `code` and `artifacts` at the host. Keep the old
   records until the new stack answers, so a rollback is a DNS TTL wait, not a
   rebuild.
2. **Artifact origin first.** It is independent: it needs the signing key and the
   volume, no session, no upstream. Deploy it, then read one document through a
   signed URL from a shell. If this fails, nothing else should be cut over.
3. **BFF.** Deploy the stack, then run the smoke check against the new origin
   (`pnpm --filter @openchat/server run smoke:remote`, see
   [`04-remote-host.md`](04-remote-host.md)) — login, `/api/info`, SSE, and the
   "no secret in the four bodies" scan.
4. **Code host last.** It needs the ticket secret on both sides and a shared
   registrable domain. Verify the framed exchange (ticket → cookie → proxied
   `/api/*`), then set `CODE_SURFACE`-equivalent configuration (`CODE_HOST_ORIGIN`)
   on the BFF last, so a broken code origin never blocks chat.

**The two auth systems must never run in parallel.** The predecessor's
`forward_auth` sidecar and OpenChat's session/basic auth both terminate at the
edge, and a browser can end up holding both cookies while both stacks answer.
Run exactly one at a time:

- Cut over by DNS, not by running both stacks behind the same hostname.
- Do not point the new `chat` host at the old stack (or vice versa) "just for a
  test"; use a separate temporary hostname or `/etc/hosts`, with the new stack's
  own cookie names.
- The old gate cookie and the new session cookie have different names and paths,
  so a stray one is inert — but a stray **edge** Basic credential is not: if the
  new stack runs `AUTH_MODE=session`, remove the old `basic_auth` block (or
  accept it as a second layer deliberately, per architecture 03).
- Keep the old stack read-only (stop its writes, keep its volumes) until the
  checklist below passes; do not delete its volumes before the backup restore
  test.

Before the old stack is removed, all of these must be true:

1. `chat.<domain>` login works with the new credential; logout clears the cookie.
2. The smoke check exits `0` against the new origin and prints no secret.
3. `/api/info` reports `host.reachable: true` and the pinned OpenCode version.
4. One artifact is created in the new stack and opens in the frame; its URL
   expires after 15 minutes.
5. The Code surface completes ticket → cookie → proxied API in the frame.
6. `docker compose ps` shows every healthcheck healthy and no restart loop;
   `restart: unless-stopped` survived one manual `docker restart` of the BFF.
7. A `deploy/swap.sh` round trip was rehearsed (candidate → rollback → candidate).
8. `opencode-data`, `opencode-config`, `workspace`, the artifact volume and
   `.env` are backed up **from the new stack**, and a restore into a scratch
   directory was tested.
9. The old edge config no longer proxies to the old stack, and its containers are
   stopped.

Only then remove the old stack's containers and (after the retention window) its
volumes.

## Secrets

- `.env` lives beside `compose.yaml`, mode `0600`, owned by the service user; it
  is git-ignored and never synced into an image (the invariant test asserts no
  Dockerfile copies `.env` or bakes an `ENV` secret).
- Required values use `${VAR:?message}`, so a missing secret is a start failure,
  not a default. `deploy/env.example` ships every secret empty.
- `OPENCODE_PASSWORD` is canonical for OpenCode's Basic auth; the BFF and the
  Code host read the same value. `SESSION_SECRET`, `CODE_TICKET_SECRET` and
  `ARTIFACT_SIGNING_KEY` are independent (different purposes, different
  rotations).
- Rotating `SESSION_SECRET` invalidates every session; rotating
  `CODE_TICKET_SECRET` invalidates open Code cookies; rotating
  `ARTIFACT_SIGNING_KEY` invalidates every outstanding artifact URL (the next
  read re-signs).
- No secret is passed on a command line: swap.sh uses `--env-file` only, and the
  smoke check reads `OPENCHAT_PASSWORD`/`OPENCODE_PASSWORD` from the environment.

## Tests

| File | Covers |
| --- | --- |
| `apps/server/test/deployment.test.ts` | compose service set; no `privileged: true`; only bff + artifact-host publish, loopback only, never 4096/8090; `TRUST_PROXY` off by default in compose and the env template; artifact volume `:ro` in the host and read-write only in the BFF; `read_only` + tmpfs for the three app services; `mem_limit`/`cpus`/`pids_limit`/log rotation/`restart` per service; a healthcheck per service; profiles on the optional three; artifact origin off `backend`; every secret an interpolation; empty secrets in the template; digest-pinned multi-stage images; frozen-lockfile installs; non-root `USER node` + tini + healthcheck; no install in the runtime stage; tool image toolchain and CLI; the docker CLI tarball verified against its release checksum before unpacking; no `.env` copied; swap-script shape |
| `apps/server/test/swap.test.ts` | dry run mutates nothing and calls no docker; successful swap writes `current`; `previous` records the prior release; rerun is a no-op; rollback on an unhealthy candidate and on a failing `up`; version mismatch; version accepted in a spaced JSON body; degraded host accepted; usage errors exit 2; missing `.env` and an out-of-tree release are refused; no secret on a compose command line |
| `apps/server/test/static.test.ts` | `WEB_DIST_DIR` parsing; shell/no-store; SPA fallback; immutable assets; missing asset is not the shell; reserved routes case- and slash-insensitive (`/API/info`, `//api/info`, `/healthz/`) and a build file named `api` unserved; assets and client routes still served; `/api`/`/healthz`/non-GET untouched; HEAD without body; traversal and malformed-escape refusal |

## Manual acceptance (not run here)

1. `docker build -f deploy/Dockerfile.bff .` for all three images, then
   `docker compose config -q` with a filled `.env`.
2. `docker compose up -d` with `OPENCODE_URL` at a real service: `docker compose
   ps` healthy, `/healthz` 200, login, SSE, one artifact, the Code frame.
3. `docker compose --profile tools --profile dind up -d toolbox dind`, then
   `docker compose exec toolbox docker run --rm hello-world`.
4. `deploy/swap.sh --dry-run`, then a real swap with a deliberately broken
   candidate to watch the rollback on the host.
5. Confirm on the host that the artifact volume quota, the RAM watchdog unit and
   the dind image GC exist — none of them is compose configuration.
