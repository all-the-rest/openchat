# 20 — Remote deployment: SSH driver, host storage, edge wiring

**Status:** 2026-11-18. Implements the remote half of issue #20: the deploy
driver, the OpenCode image derived from upstream, the host-only `.env`
bootstrap, the size-capped loopback disks and the Caddy fragment for the owner's
VPS. It builds on [`14-deployment.md`](14-deployment.md) (the committed stack,
`deploy/swap.sh`, the env template) and does not change it.

**Not executed against the VPS.** No SSH connection was opened and no deploy was
run. What *was* executed locally: the derived image build, its entrypoint and
tool checks, the shell scripts against temp fixtures, and `caddy validate` with
the real `caddy:2-alpine` binary. The manual acceptance steps are at the end.

## What ships

| Piece | Path | What it is |
| --- | --- | --- |
| OpenCode image | `deploy/Dockerfile.opencode` | official `opencode:2.3.2` + git, ripgrep, Docker CLI, Node, artifact tool |
| Remote overlay | `deploy/remote/compose.yaml` | `webnet` edge network, memory caps, loopback disks |
| Edge fragment | `deploy/remote/Caddyfile.openchat` | three site blocks, imported by the host Caddy |
| Driver | `deploy/remote/deploy.sh` | sync, disks, `.env`, build, swap, Caddy; `--dry-run` |
| Disks | `deploy/remote/mount-disks.sh` | create/mount/unmount the three ext4 images |
| Env bootstrap | `deploy/remote/env-bootstrap.sh` | writes `.env` once, escaped, `0600`, never printed |
| Escape filter | `deploy/remote/env-value.sh` | doubles `$` for Compose, idempotent |
| MCP seed | `deploy/remote/seed-config.sh` | one `local` entry in `opencode.json`, once |
| Caddy install | `deploy/remote/caddy.sh` | import line, validate, reload, remove |
| Boot unit | `deploy/remote/openchat-disks.service` | mounts the images before Docker |
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
   dind) after the free-space check.
4. Bootstrap `/opt/stacks/openchat/.env` **once**. An existing file is kept
   byte-for-byte; a deploy never rotates a secret.
5. Seed `/opt/stacks/openchat/opencode-config/opencode.json` **once** with the
   artifact MCP entry.
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
`$TAG` the short commit sha):

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
| `--artifacts-size` / `--workspace-size` / `--dind-size` | `2G`/`4G`/`4G` | image sizes (create only) |
| `--reserve` | `10G` | free space that must remain |
| `--dry-run` | off | print `would: …`, change nothing |
| `--unmount` | — | unmount the images; refuses while the stack runs |
| `--uninstall` | — | remove the Caddy fragment and stop the stack |

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
file is absent**, then mounted with `mount -o loop`. Sizes are recorded in
`disks/layout`, which a boot-time run reads, so a unit start cannot drift from
the images that exist; an explicit flag wins over the file. `--umount` syncs and
detaches, and refuses while a container of project `openchat` is running.

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
- The BFF is not shrunk to make dind fit: it owns the login, the SSE stream and
  every API route, and is the availability-critical process.

## Caddy: import, validate, reload

The fragment has three site blocks (`chat.`, `code.`, `artifacts.`), each
proxying to the overlay's DNS alias. It is additive and reversible:

1. `caddy.sh` writes the rendered fragment to `/etc/caddy/openchat.caddy` inside
   the existing `caddy` container (a mounted volume).
2. It copies `Caddyfile` to a candidate **in the same directory**, appends
   `import openchat.caddy` once (exact-line match), and runs
   `caddy validate --config Caddyfile.openchat.tmp --adapter caddyfile`.
3. Only a successful validation is moved over `Caddyfile`; then
   `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.
4. `--remove` drops the import line and the fragment, validates and reloads.

The host's own blocks are never edited. The import line is the only host-file
change, matched exactly, so a second run adds nothing.

**Validation is a required step, not a formality.** An earlier version of the
fragment used `encode zstd gzip { match { not header Content-Type … } }`.
`caddy validate` rejected it with `unrecognized response matcher not` before any
reload; the running sites were untouched. The working form, validated against
`caddy:2-alpine`, is a named matcher:

```
@compressible not header Content-Type text/event-stream*
encode @compressible zstd gzip
```

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
the `encode` matcher leaves `text/event-stream` uncompressed. The `artifacts`
block has no `encode` and no cache header: the upstream's
`Cache-Control: no-store` and CSP stay authoritative, and a signed document must
not be kept past its signature's expiry. `header_up X-Forwarded-For
{remote_host}` overwrites, never appends, because the BFF runs `TRUST_PROXY=1`.
There is no `basic_auth` and no `forward_auth`: the app's own login is the gate.

`--uninstall` removes the fragment and stops the stack, but keeps `.env`, the
disk images and the volumes; delete them only after a restore test.

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
one place to adjust; it creates the file once and reports the entry count instead
of rewriting an agent-edited file.

## What the tests pin

`apps/server/test/remote-deploy.test.ts`:

- the Dockerfile's base tag, the absence of `latest`, and that entrypoint, CMD
  and user are inherited; every `COPY` source in every `deploy/` Dockerfile
  exists (the check that catches a `packages/` vs `apps/` typo);
- overlay network, aliases, memory limits and the pinned `OPENCODE_URL`;
- a full `deploy.sh --dry-run`, refusal of secret arguments, the dind headroom;
- the `$` escape through the real filter, idempotency, the measured corruption
  and its repair;
- `.env` bootstrap: 0600, escaped digest, generated secrets, keep-existing,
  nothing printed; MCP config: 0644, exact command paths, one-time creation;
- disk dry-run arithmetic, layout reuse, the busy-unmount refusal;
- Caddy: the named matcher (and no invalid `encode` block), three origins, SSE
  and header rules, validate-before-move, remove path;
- the runbook states the interpolation rule, `Valid configuration` and the
  no-HTTP-auth boundary.

`deployment.test.ts` keeps the static stack invariants (published ports,
read-only artifact mount, writer set, no secrets in compose) and
`release-workflow.test.ts` pins that every compose Dockerfile is in the release
matrix and that no matrix entry points at a missing file.

## Manual acceptance on the host

1. `deploy/remote/deploy.sh --dry-run` — read the printed steps; nothing changes.
2. `deploy/remote/deploy.sh` — watch the disk check, the `.env` creation (values
   never printed), the five builds and the swap.
3. `docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter
   caddyfile` — `Valid configuration`.
4. `curl -sI https://chat.<domain>/healthz` — `200`; login works; `/api/info`
   answers `200` or `401` for an unauthenticated probe.
5. One artifact through a signed URL, one Code ticket exchange in the frame.
6. `docker compose -p openchat ps` — every service up, no restart loop.
7. Rehearse a rollback (`swap.sh` with the previous release) and a rerun.

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
