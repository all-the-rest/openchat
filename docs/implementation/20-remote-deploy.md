# 20 — Remote deployment: SSH driver, host storage, edge wiring

**Status:** 2026-11-18. Implements the remote half of issue #20: the deploy
driver, the OpenCode image derived from upstream, the host-only `.env`
bootstrap, the size-capped loopback disks and the Caddy fragment for the owner's
VPS. It builds on [`14-deployment.md`](14-deployment.md) (the committed stack,
`deploy/swap.sh`, the env template) and does not change it.

**Live since 2026-11-18.** The layer was deployed to `root@reisinger.pictures`:
release `20261118T141759Z` serves `https://chat.reisinger.pictures` with BFF
2.0.0 and OpenCode 2.3.2, the four application containers are healthy, and the
artifact write plus persistence across a container restart were verified. The
host Caddy's other sites stayed up (13 site blocks in total on the box). What is
still owner-only is the browser login with the real password; the acceptance
steps that need it at the end are marked. Locally: the derived image build, the
helper scripts against temp fixtures, and `caddy validate`/`caddy adapt` plus
routing probes against `caddy:2-alpine`.

## What ships

| Piece | Path | What it is |
| --- | --- | --- |
| OpenCode image | `deploy/Dockerfile.opencode` | official `opencode:2.3.2` + git, ripgrep, Docker CLI, Node, artifact tool |
| Remote overlay | `deploy/remote/compose.yaml` | `webnet` edge network, memory caps, loopback disks |
| Edge fragment | `deploy/remote/Caddyfile.openchat` | three site blocks, imported by the host Caddy; `/internal/*` refused |
| Driver | `deploy/remote/deploy.sh` | sync, disks, `.env`, build, swap, Caddy; `--dry-run` |
| Driver safety | `deploy/remote/ssh-safe.sh` | quoting and validation for every remote command value |
| Disks | `deploy/remote/mount-disks.sh` | create/mount/unmount the three ext4 images, chown, marker |
| Env bootstrap | `deploy/remote/env-bootstrap.sh` | writes `.env` once, escaped, `0600`, never printed |
| Escape filter | `deploy/remote/env-value.sh` | doubles `$` for Compose, idempotent |
| MCP seed | `deploy/remote/seed-config.sh` | one `local` entry in `opencode.json`, `0600`, once |
| Caddy install | `deploy/remote/caddy.sh` | staged validate, import line, reload, backup, remove |
| Boot unit | `deploy/remote/openchat-disks.service` | mounts the images before Docker |
| Disk gate | `deploy/remote/compose.yaml` (`disks-ready`) | refuses to start services on an unmounted disk |
| Runbook | this file | facts, arithmetic, commands, boundaries |

## Host facts that shaped this

Measured on `root@reisinger.pictures` before this layer was written:

- `/` is **XFS with `noquota`**; Docker 29 uses the **containerd snapshotter**.
  Per-container `storage_opt.size` is therefore unavailable. A loopback ext4
  image mounted at a host directory is the only hard size cap that works.
- **48 GiB free**, **`MemAvailable` ≈ 3.6 GiB**. The predecessor stack still runs
  beside OpenChat, and it is the box's largest tenant.
- The edge is an existing **`caddy` container** on the external `webnet`
  network; it owns 80/443 and the certificates for the host's other sites.

## One deploy, step by step

`deploy/remote/deploy.sh` does, in order:

1. `rsync` the build context to `/opt/stacks/openchat/src/<short-sha>`.
   `node_modules`, `.git`, `dist`, `references`, coverage and `.env*` are
   excluded; the source tree is the build context on the host, not a registry.
2. Install `mount-disks.sh` and `caddy.sh` as `/opt/stacks/openchat/bin/*`, the
   systemd unit as `/etc/systemd/system/openchat-disks.service`, enable it, and
   record `disks/layout` (sizes and reserve).
3. Create and mount the ext4 images (2 GiB artifacts, 4 GiB workspace, 4 GiB
   dind) after the free-space check, chown each mount root to `1000:1000` and
   write its `.openchat-disk` marker.
4. Bootstrap `/opt/stacks/openchat/.env` **once**. An existing file is kept
   byte-for-byte; a deploy never rotates a secret.
5. Seed `/opt/stacks/openchat/opencode-config/opencode.json` **once** with the
   artifact MCP entry. Later runs keep its bytes and repair its mode to `0600`.
6. With `--with-dind`, read `/proc/meminfo` and refuse below the headroom.
7. Build the five images on the host: `bff`, `code-host`, `artifact-host`,
   `opencode`, `tools`. The image cache lives beside the predecessor's; nothing
   is pulled from a registry.
8. Render the release: `docker compose … config --no-interpolate` into
   `releases/<utc>/compose.yaml` (mode `0600`) and the Caddy fragment with the
   domain substituted. `--no-interpolate` keeps `${…}` references, so **no
   secret is baked into a release file**.
9. `deploy/swap.sh` validates and swaps `current`, with rollback.
10. Install the Caddy fragment and reload. This is deliberately last: a failed
    deploy never takes the existing sites down and no certificate is requested
    for a dead upstream.

Rerunning is idempotent: the same tag maps to the same source tree, existing
images are reused, `.env` and `opencode.json` are kept, mounted disks are a
no-op, and `swap.sh` validates a `current` that already points at the candidate
without moving links.

### The exact compose command line

Every remote compose call has this shape (`$SRC` is the synced source tree,
`$TAG` the short commit sha). The driver assembles it as one shell string with
every word single-quoted:

```
env OPENCHAT_TAG=$TAG COMPOSE_PROFILES=opencode \
  docker compose --project-name openchat \
    --env-file /opt/stacks/openchat/.env \
    --file $SRC/compose.yaml \
    --file $SRC/deploy/remote/compose.yaml \
    <subcommand>
```

`COMPOSE_PROFILES=opencode` starts the application services plus the derived
OpenCode service. `--with-dind` extends it to `opencode,tools,dind`; the render
step always uses all three so profiled services are present in the release file,
while the running profile is what decides whether they start. Shell environment
beats `--env-file`, so a stale `OPENCODE_URL` in `.env` cannot point the stack
at the predecessor (the overlay pins it too).

### Remote command safety

`ssh` joins its argv with spaces and the remote shell parses the result, so a
value with a space would arrive as two words unless the whole command is quoted.
`deploy/remote/ssh-safe.sh` provides one POSIX `shquote` (`'` becomes `'\''`)
and every remote command is built as a single quoted string; the driver passes
`ssh -- "$HOST" "$command"`, and `--host` is validated to `USER@HOST` first so
`-oProxyCommand=…` cannot be an ssh option.

The inputs are also validated before anything runs (usage error, exit 2):
`--stack-dir` and `--predecessor-env` must be absolute, control-byte-free and
free of `..` segments; `--expect-version` must be `major.minor.patch` (optional
`-suffix`); the four sizes must be positive with a K/M/G/T suffix; `--tag` and
`--domain` keep their existing character sets. A path may still contain a space
or a `;` — quoting, not rejection, is what makes it inert.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host` | `root@reisinger.pictures` | SSH target |
| `--domain` | `reisinger.pictures` | base domain; origins become `chat.`/`code.`/`artifacts.` |
| `--stack-dir` | `/opt/stacks/openchat` | stack root on the host |
| `--predecessor-env` | `/opt/stacks/dev-vm/.env` | source of `AUTH_USER`/`AUTH_HASH` |
| `--tag` | short commit sha | image tag |
| `--with-dind` | off | start `toolbox` + `dind`, after the memory check |
| `--expect-version` | none | fail the swap unless `/healthz` reports it |
| `--artifacts-size` / `--workspace-size` / `--dind-size` | `2G`/`4G`/`4G` | image sizes (create only; positive, K/M/G/T suffix) |
| `--reserve` | `10G` | free space that must remain (same shape) |
| `--dry-run` | off | print `would: …`, change nothing |
| `--unmount` | — | unmount the images; refuses while the stack runs |
| `--uninstall` | — | remove the fragment, stop the stack, remove the unit and `bin` |

No secret is accepted as an argument: a `KEY=VALUE` or `--password …` argument is
a usage error. Nothing in the driver prints a value.

## The host-only `.env`

`env-bootstrap.sh` creates `/opt/stacks/openchat/.env` with mode `0600` and
never overwrites it. Keys, and where their values come from:

| Keys | Source |
| --- | --- |
| `APP_ORIGIN`, `CODE_HOST_ORIGIN`, `ARTIFACT_HOST_URL` | `--domain` |
| `AUTH_MODE=session`, `OPENCHAT_USER` | fixed / predecessor `AUTH_USER` |
| `OPENCHAT_PASSWORD_HASH` | predecessor `AUTH_HASH`, `$` escaped (below) |
| `SESSION_SECRET`, `CODE_TICKET_SECRET`, `ARTIFACT_SIGNING_KEY` | `openssl rand -base64 32` |
| `OPENCODE_PASSWORD` | `openssl rand -base64 24` |
| `ARTIFACT_INTERNAL_TOKEN` | `openssl rand -hex 32` |
| `TRUST_PROXY=1`, `COOKIE_SECURE=1` | fixed (Caddy overwrites `X-Forwarded-For`) |
| `OPENCODE_URL=http://opencode:4096` | fixed for the in-stack service |
| `OPENCODE_USERNAME=opencode` | fixed |
| `BFF_PORT`, `ARTIFACT_PORT`, TTLs, `ALLOW_INSECURE_COOKIE=0` | fixed defaults |
| `STT_URL`, `STT_API_KEY`, dictation and toolbox keys | empty/omitted; compose defaults apply |

`OPENCHAT_PASSWORD` stays empty: the digest wins, so the plaintext never reaches
the host. `ARTIFACT_INTERNAL_TOKEN` is one value read by two processes — the
BFF's `/internal/artifacts` route and the artifact tool in the OpenCode
container — and is distinct from `ARTIFACT_SIGNING_KEY` (that signs URLs, this
authorizes writes).

Rotation is an owner action: edit the file in place (`chmod 600`), then
`docker compose … up -d` for the affected services. A deploy will not do it.

### Dollar signs in `.env`

Compose interpolates `$…` inside env-file values. Measured with the pinned
Compose and a `.env` containing:

```
OPENCHAT_PASSWORD_HASH=$2b$12$abc…
```

the rendered container value is **`$2b$12`**: `$2b` and `$12` are literal
because a variable name cannot start with a digit, but `$abc…` is an unset
variable and expands to nothing. Login can then never succeed — silently.

The rule: write every `$` as `$$`. `deploy/remote/env-value.sh` does it for the
copied digest, is idempotent (an already escaped value passes through), and
`env-bootstrap.sh` writes:

```
OPENCHAT_PASSWORD_HASH=$$2b$$12$$abc…
```

The same applies to a hand-written plaintext password containing `$`. `docker
compose config` is the way to check: the value in the rendered service must be
the full digest, not a prefix.

## Disk budget and mounts

```
disks/artifacts.img  2 GiB  ->  disks/artifacts   bff (rw), artifact-host (ro)
disks/workspace.img  4 GiB  ->  disks/workspace   opencode, toolbox (rw), bff (ro)
disks/dind.img       4 GiB  ->  disks/dind        rootless dockerd storage
```

Arithmetic against the 48 GiB free: 10 GiB loopback images + roughly 4 GiB for
the five images and the build cache + the 10 GiB reserve = **24 GiB**, leaving
half the volume for the predecessor and future releases. The reserve is checked
before anything is created: if `free − missing images < reserve`, the script
refuses and names all three numbers. Existing images are never shrunk; changing
a size is an owner decision.

The images are created with `truncate -s` + `mkfs.ext4 -F -q` **only when the
file is absent**, then mounted with `mount -o loop`. `truncate` and `mkfs` run on
`<name>.img.tmp` and the file is moved into place only after `mkfs` succeeds: a
failure removes the temp file and stops before any mount, so a 0-byte `.img`
never becomes state the next run trusts. A bad size dies before any arithmetic
with the flag named:
`--artifacts-size must be a number with a K/M/G/T suffix: 2X`. Sizes are
recorded in `disks/layout`, which a boot-time run reads, so a unit start cannot
drift from the images that exist; an explicit flag wins over the file.
`--umount` syncs and detaches, and refuses while a container of project
`openchat` is running.

**Ownership.** A named volume inherits the mode of the directory baked into the
image; a bind mount from the root of a fresh ext4 image is `root:root 0755`.
The BFF, the artifact host and the tools image run as uid/gid 1000, and the
rootless dind daemon is uid 1000 in its container, so `mount-disks.sh` chowns
each mount root to `1000:1000` after mounting — and again when the target is
already mounted, so a rerun repairs an older image. It is not recursive; only
the mount root needs to be writable. Without it `docker exec openchat-bff-1
touch /artifacts/.probe` answers `Permission denied` and a write fails with
`the BFF answered 500`. A failed `chown` stops the script before Docker starts.

**Mount gate.** `Before=docker.service` only orders; a failed mount would still
let Compose start containers on the empty bind directories and put artifact and
workspace data on the root filesystem. `mount-disks.sh` therefore writes
`.openchat-disk` inside each mounted image, and the overlay's `disks-ready`
service (stock `alpine:3`, 64 MiB cap, three `test -f`; pulled once by
`docker compose up`) must complete successfully before `bff`, `artifact-host`,
`opencode`, `toolbox` and `dind` start. The marker cannot exist on an unmounted
directory, so the failure is a refused start, not silent data loss. A failed
unit is visible in `systemctl --failed`.

**No `docker.service` drop-in, on purpose.** A reviewer will suggest
`Requires=openchat-disks.service` in `/etc/systemd/system/docker.service.d/`.
That makes a failed mount stop Docker itself, taking the host's other sites with
it — the failure mode is worse than the one it fixes. The gate is scoped to this
stack: a failed mount refuses these five services and leaves everything else
running, while `systemctl --failed` still reports the unit. `deploy.sh` installs
no drop-in and must not start doing so.

Boot persistence is the installed `openchat-disks.service` (`Before=docker.service`),
not `/etc/fstab`: the images are deployment state and an fstab entry would be a
host-wide change this stack does not make implicitly.

## Memory budget

The overlay's limits: `bff` 512m, `code-host` 256m, `artifact-host` 128m,
`opencode` 1536m, `toolbox` 512m, `dind` 1024m.

- Without `--with-dind`: **2432 MiB** of limits (512+256+128+1536). That fits the
  measured ~3.6 GiB `MemAvailable` with room for page cache.
- With `--with-dind`: **3968 MiB**, which does not fit. The driver therefore
  reads `MemAvailable` and refuses below **5120 MiB** (the limit sum plus ~1 GiB
  for the host and the predecessor). Stop the predecessor or drop the flag.
- The BFF keeps 512 MiB. The base file gives it 768m, so the overlay does lower
  it, but only to the same cap as `toolbox`; it is not cut further to make dind
  fit. It owns the login, the SSE stream and every API route, and is the
  availability-critical process.

## Caddy: stage, validate, move, reload

The fragment has three site blocks (`chat.`, `code.`, `artifacts.`), each
proxying to the overlay's DNS alias. It is additive and reversible:

1. `caddy.sh` writes the rendered fragment to
   `/etc/caddy/.openchat-stage/openchat.caddy` inside the existing `caddy`
   container (a mounted volume).
2. It copies the host `Caddyfile` beside it — keeping the untouched original as
   `/etc/caddy/Caddyfile.openchat.bak` on the first install and printing that
   path — appends `import openchat.caddy` once (exact-line match), and runs
   `caddy validate --config /etc/caddy/.openchat-stage/Caddyfile --adapter caddyfile`.
   Imports resolve relative to the importing file, so the staged pair has the
   same names and bytes the live pair will have.
3. Only after a successful validation are both files moved into place — the
   fragment first, then the `Caddyfile` — and
   `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` runs.
   A failed validation deletes the staging directory and leaves the live
   fragment and Caddyfile byte-identical, so a reboot cannot start Caddy on a
   broken import.
4. `--remove` stages an import-less `Caddyfile`, validates it, moves it, then
   removes the fragment and reloads. The same rule holds: a failed validation
   changes nothing.
5. The backup is never rewritten: later installs keep the file from the first
   one. It is the file to restore by hand if a reload succeeds but the running
   config must be rolled back.

The host's own blocks are never edited. The import line is the only host-file
change, matched exactly, so a second run adds nothing.

**Validation is a required step, not a formality.** Two rejected forms were
measured against `caddy:2-alpine`; both failed before any reload:

- `encode zstd gzip { match { not header Content-Type … } }` → `parsing caddyfile
  tokens for 'encode': unrecognized response matcher not`;
- the older `@compressible not header Content-Type text/event-stream*` +
  `encode @compressible` form validates, but `caddy adapt` places the matcher at
  route level (a *request* matcher), and an SSE probe then answers
  `Content-Encoding: gzip`.

The working form is structural: `/api/events` gets its own `handle`, the
catch-all `handle` carries `encode`:

```
handle /api/events* {
	reverse_proxy openchat-bff:8787 { flush_interval -1 … }
}
handle {
	encode zstd gzip
	reverse_proxy openchat-bff:8787 { flush_interval -1 … }
}
```

Measured on `caddy:2-alpine` with a 700-byte `text/event-stream` body and a
700-byte `text/html` body (`Accept-Encoding: gzip, zstd`): `/api/events` →
`Content-Type: text/event-stream`, **no** `Content-Encoding`; `/` →
`Content-Encoding: zstd`. `handle` blocks are ordered and exclusive, so the
split is structural rather than a matcher subtlety. The `code` origin proxies
OpenCode's event stream on the same `/api/events` path, so it carries the same
split; `artifacts` has no `encode` at all.

To check the installed file on the host before a reload:

```
docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

The last line must be **`Valid configuration`**; anything else means the
candidate must not be installed. The same command against the repository copy
(with the domain substituted and `import openchat.caddy` wired into a test
Caddyfile) printed exactly:

```
Valid configuration
```

SSE safety: `flush_interval -1` on `chat` and `code` flushes every write, and
`/api/events` is served by a handle without `encode`. The `artifacts`
block has no `encode` and no cache header: the upstream's
`Cache-Control: no-store` and CSP stay authoritative, and a signed document must
not be kept past its signature's expiry. `header_up X-Forwarded-For
{remote_host}` overwrites, never appends, because the BFF runs `TRUST_PROXY=1`.
There is no `basic_auth` and no `forward_auth`: the app's own login is the gate.

**The internal write route is not published.** `POST /internal/artifacts`
accepts artifact writes and checks only the bearer token, so the internet must
not reach it: the chat block has `handle /internal/* { respond 404 }` before the
catch-all. 404 rather than 403, because the edge should not confirm that an
internal route exists. The guard is Caddy-only by design — the MCP tool posts to
`http://bff:8787` on the compose `backend` network and never passes through
Caddy, so container-to-container writes keep working. Measured on
`caddy:2-alpine` with the fragment adapted (`/internal/*` becomes
`static_response` 404, with no `encode` and no `reverse_proxy`): through the edge
`POST /internal/artifacts` → **404**, while `POST /api/events` → 200 and
`POST /other` → 200; the same POST sent directly between containers → 200.

`--uninstall` removes the fragment and its import, stops the stack, then
`systemctl disable --now`s the unit, deletes
`/etc/systemd/system/openchat-disks.service`, reloads systemd and removes
`/opt/stacks/openchat/bin`. It deliberately keeps `.env`, the disk images (the
data inside them) and `/etc/caddy/Caddyfile.openchat.bak`; delete those only
after a restore test. A later deploy reinstalls the unit and `bin`, and the
repo's `deploy/remote/mount-disks.sh --umount` detaches a kept image.

## Security boundary: OpenCode 2.3.2 has **no HTTP auth**

Measured by running the pinned image and curling it: `serve --hostname 0.0.0.0
--port 4096` answers `200` on `/session`, `/config`, `/app`, `/event` and
`/global/health` without credentials, with `OPENCODE_SERVER_PASSWORD`, with
`OPENCODE_PASSWORD`, and with both. The 1.x server password is gone in 2.x.

Consequences, and they are deliberate:

- The only protection for the OpenCode API is **network isolation**. `opencode`
  is attached to `backend` only; `backend` is not published; the browser reaches
  it exclusively through the BFF's ticket-protected Code routes.
- `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` are still forwarded because the BFF
  sends them, but they do **not** authenticate anything on 2.3.2 and must not be
  relied on. A future OpenCode that restores auth is tracked in issue #38.
- Do not "fix" this by binding OpenCode to `127.0.0.1` (the BFF could not reach
  it) or by publishing a port (that would expose an unauthenticated API).
- `POST /internal/artifacts` is a container-to-container route: bearer-only, and
  refused at the edge (`handle /internal/*` answers `404`). The token lives in
  the root-only `opencode.json` and is never a browser credential.
- Any other container attached to `backend`, or root on the host, can call the
  API. That is the same trust level as the BFF itself, and the reason `backend`
  must never be shared with an untrusted stack.

## OpenCode version policy

`compose.yaml` defaults to `ghcr.io/anomalyco/opencode:2.3.2` (interpolated as
`${OPENCODE_IMAGE:-…}`). The tag is versioned and must match the
`@opencode/client` range the app pins (`^2.3.0`, lockfile 2.3.2). The
`latest` tag is **1.19.6**, the stale 1.x line — never use it. 2.3.3+ do not
exist yet; the upgrade path is issue #38.

## The derived image

`deploy/Dockerfile.opencode` is `FROM ghcr.io/anomalyco/opencode:2.3.2` plus
what upstream does not ship:

- `git`, `ripgrep`, `curl`/`ca-certificates` — agent tools and the CLI download;
- **Node.js** (`apk add nodejs`): the official image has no `node` and no `bun`,
  so the artifact tool's `tsx` runtime cannot run without it. The entrypoint
  (`opencode`), the user (root, unset) and the working directory stay upstream's;
  no `ENTRYPOINT`, `CMD` or `USER` line overrides them. Compose supplies
  `serve --hostname 0.0.0.0 --port 4096` as arguments to that entrypoint.
- the static Docker **CLI** (no daemon) from `download.docker.com`, verified
  against the sidecar `.sha256` before unpacking, with `TARGETARCH` mapped to
  `x86_64`/`aarch64` for the multi-arch release build;
- the artifact tool at `/opt/artifact-tool` (outside `HOME`, so a writable config
  volume cannot shadow it). `tsx` is installed next to its package by pnpm; the
  image pins `/opt/artifact-tool/node_modules/.bin/tsx` as a symlink so the MCP
  command has one stable path. The entry is
  `/opt/artifact-tool/packages/artifact-tool/src/index.ts`.

Build proof (worktree, amd64):

```
docker build -f deploy/Dockerfile.opencode -t openchat-opencode:probe .
# … exporting to image … naming to docker.io/library/openchat-opencode:probe done
```

Result: **797 MB**, `User` unset, `Entrypoint ["opencode"]`, `Cmd null`. Inside
that image: `opencode --version` → `opencode v2.3.2`; `node v24.22.3`,
`tsx v4.23.15`, `git 2.54.1`, `ripgrep 15.1.0`, `Docker version 29.10.0`; and
`tsx …/src/index.ts` with an empty stdin and a token exits `0` (without the token
it refuses by name). The config seed carries both variables the tool reads:
`OPENCHAT_BFF_URL=http://bff:8787` and `ARTIFACT_INTERNAL_TOKEN`.

If a future OpenCode release changes the config schema, `seed-config.sh` is the
one place to adjust; it creates the file once, repairs its mode to `0600` on
later runs, and reports the entry count instead of rewriting an agent-edited
file.

## What the tests pin

`apps/server/test/remote-deploy*.test.ts` (the fixture module is
`remote-deploy-fixtures.ts`):

- the Dockerfile's base tag, the absence of `latest`, and that entrypoint, CMD
  and user are inherited; every `COPY` source in every `deploy/` Dockerfile
  exists (the check that catches a `packages/` vs `apps/` typo);
- overlay network, aliases, memory limits, the pinned `OPENCODE_URL`, and the
  `disks-ready` gate with its `service_completed_successfully` dependants;
- a full `deploy.sh --dry-run`, refusal of secret arguments, the dind headroom,
  and a hostile-value replay: each rendered remote command is executed under a
  real `sh -c` and must not create a marker file;
- the `$` escape through the real filter, idempotency, the measured corruption
  and its repair;
- `.env` bootstrap: 0600, escaped digest, generated secrets, keep-existing,
  nothing printed; MCP config: 0600, exact command paths, one-time creation;
- disks: dry-run arithmetic, layout reuse, busy-unmount refusal, size
  validation for all four flags, temp-image creation, chown order after mount
  (also on the already-mounted branch) and the marker;
- Caddy: the `/api/events` handle without `encode` and `encode` only in the
  catch-all; the `/internal/*` guard answers `404` with no `encode` and no
  `reverse_proxy`, and the in-network MCP path is BFF-direct; three origins, SSE
  and header rules, staged validate-before-move (live files byte-identical on
  failure), backup path, remove path;
- `--uninstall` stops the stack, disables and removes the unit, removes `bin`,
  and prints what it keeps;
- the runbook states the interpolation rule, `Valid configuration`, the live
  state and the no-HTTP-auth boundary.

`remote-compose-merge.test.ts` merges `compose.yaml` with the overlay through
`docker compose config --no-interpolate` and asserts that **every** service has a
`mem_limit`, that `/artifacts`, `/workspace` and the dind storage path are binds
under `disks/` (never named volumes), and that every image except the pinned
`dind` and the stock `disks-ready` gate is `openchat-*:${OPENCHAT_TAG}`. That is
the guard against the additive overlay: a seventh base service without an
overlay entry fails here instead of shipping uncapped.

`deployment.test.ts` keeps the static stack invariants (published ports,
read-only artifact mount, writer set, no secrets in compose) and
`release-workflow.test.ts` pins that every compose Dockerfile is in the release
matrix and that no matrix entry points at a missing file.

## Acceptance on the host

Verified during the live deploy (release `20261118T141759Z`):

1. `deploy/remote/deploy.sh --dry-run` then `deploy/remote/deploy.sh` — disks,
   `.env` (values never printed), five builds, swap, Caddy last.
2. `docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter
   caddyfile` — `Valid configuration`; the other site blocks kept serving.
3. `curl -sI https://chat.<domain>/healthz` — `200`; `/api/info` answers `200`
   or `401` for an unauthenticated probe; `POST /internal/artifacts` through the
   edge answers `404`.
4. `docker compose -p openchat ps` — four application containers up, no restart
   loop; one artifact written through a signed URL and read back, including
   after a container restart.

Owner-only, because they need the real password or a human eye:

5. Browser login at `https://chat.<domain>` with the real password, and one Code
   ticket exchange in the embedded frame.
6. Rehearse a rollback (`swap.sh` with the previous release) on the live box.

## Assumptions

- The predecessor `.env` still exists at `/opt/stacks/dev-vm/.env` with
  `AUTH_USER` and a bcrypt `AUTH_HASH`. If it does not, write
  `OPENCHAT_PASSWORD_HASH` by hand (with `$$`) before the first deploy.
- The host Caddy keeps its config at `/etc/caddy/Caddyfile` inside a container
  named `caddy`, and that file's directory is writable by the container.
- `webnet` exists and the `caddy` container is attached to it.
- Docker on the host can mount loopback filesystems (root, no user namespace
  restriction on `mount`).
- Image distribution is a local build until GHCR publishing is an owner step;
  the release workflow already builds `opencode` and `tools` for both
  architectures.
