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
| Documents image | `deploy/Dockerfile.documents` | Debian + LibreOffice for `.dotx` → DOCX/PDF; internal only, no published port (issue #46) |
| Tool runtime | `deploy/code-host/tools.Dockerfile` | git, gh, ripgrep, node/pnpm, Docker CLI for agent work |
| Stack | `compose.yaml` | one project, seven services, profiles for the optional three |
| Swap | `deploy/swap.sh` | candidate validation, link swap, rollback, `--dry-run` |
| Env template | `deploy/env.example` | host-only `.env` skeleton, every secret empty |
| Host guards | `deploy/host/` | RAM watchdog, dind image GC, artifact-disk alert; systemd units + installer |
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
agent (opencode) ──backend──▶ documents:8099 never published, bearer token
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
| documents | 1500 MiB (reserve 256) | 256 | 1.0 |
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

### Python document toolchain

The OpenCode image carries Python so the document tools work offline. The base
is Alpine 3.24.4, whose repository has **Python 3.14.10** and no 3.13 package;
the issue asked for 3.13, so this is the one owner-visible deviation.

Four files are the contract:

- `packages/python-env/requirements.lock` — the pip-installed half, exact `==`
  pins, installed with `--no-deps`. It carries `markitdown 0.1.9` with the four
  format extras (`docx`, `xlsx`, `pptx`, `pdf`), `python-docx 1.2.0`,
  `reportlab 5.1.0` and their pure-Python closure (`magika 1.0.3`,
  `mammoth 1.13.0`, `pdfminer.six 20260107`, `pdfplumber 0.11.10`,
  `python-pptx 1.0.2`, `charset-normalizer`, `typing_extensions`, …).
- `packages/python-env/requirements-dev.lock` — the native half for a
  workstation, resolved from PyPI at the versions the Alpine packages provide.
- `packages/python-env/requirements-test.lock` — test-only pins for the Python
  unit tests of the tool scripts (`pypdf`, which reads the PDF text layer).
  Never installed in the image; the build proves the same behaviour with the
  `pdfminer.six` that markitdown already brings.
- `packages/python-env/apk-packages.txt` — the same native half as Alpine
  packages, pinned to `py3-onnxruntime=1.24.4-r1`, `py3-pandas=3.0.3-r0`,
  `py3-lxml=6.1.1-r0`, `py3-openpyxl=3.1.5-r1`, `py3-cryptography=47.0.0-r0`
  and `py3-pillow=12.2.0-r0`. `onnxruntime` publishes no musllinux wheel, so
  pip cannot provide it on Alpine at all; the apk packages also share their
  libraries instead of vendoring a second copy.

The font comes from apk too, in the same `RUN` as `python3`: `font-dejavu`
(2.37-r6, 9,990 KiB installed, `/usr/share/fonts/dejavu/`). reportlab embeds a
subset of it, which is what keeps umlauts, Greek and Cyrillic in the PDF text
layer; the build asserts both TTF paths and the offline smoke test extracts the
three samples. Details and the licence note:
[`25-documents.md`](25-documents.md). The font adds about 10 MiB to the Python
layer, on top of the 268 MB figure below.

`markitdown` is mandatory and available two ways: the CLI is on `PATH`
(`markitdown <file> > out.md`) and `read_document` calls its Python API for
DOCX, XLSX, PPTX and PDF. The magika model is part of the wheel (3.1 MiB under
`magika/models`), so the first conversion does no network call. The image
proves that structurally: a build step runs with `--network=none`, creates a
real DOCX/XLSX/PPTX/PDF, converts all four with both the CLI and
`read_document.py`, and checks that a corrupt DOCX yields `parse_failed` with no
traceback (`deploy/python-smoke.py`). The `all` extra is never requested — it
would add audio/video transcription and Azure clients.

Because this step is the only Linux execution of the toolchain, a path-filtered
CI job (`.github/workflows/ci-opencode-image.yml`) builds this image for
`linux/amd64` on PRs and on pushes to `main` that touch the Dockerfile, the
smoke script or `packages/python-{env,tool}/**`, plus a weekly canary. It never
pushes: it is meant to catch a Linux-only failure (v2.5.0 hit `read_document …
too_large`, an `RLIMIT_AS` limit macOS does not enforce) before the release tag
build. PR and push runs warm the same GHA cache scope (`opencode`) the release
consumes; the weekly canary rebuilds without that cache so the smoke re-executes.

Two deliberate omissions: `pypdfium2` (pdfplumber imports it only for its
optional page renderer, which `read_document` never uses; the offline PDF
conversion above covers the code path) and the `pandoc` binary (~150 MB, no
consumer). `pypdf` left the image with the switch to markitdown and is now a
test-only pin: the unit tests read the embedded font's text layer with it, the
build smoke test uses `pdfminer.six`.

A `python-wheels` stage downloads the pip half once with
`pip download --only-binary :all:` on the target architecture; the runtime
installs the apk pins first, then the wheels with
`--no-index --find-links /wheels --no-deps`, checks `python3 --version`, imports
the whole set and resolves the `markitdown` CLI in the same `RUN`, then removes
the wheelhouse, the pip cache, `py3-pip` and every `__pycache__`. No compiler
exists in either stage.

Measured on arm64: on a bare `alpine:3.24.4` (13,502,455 bytes) the same steps
produce a 391,869,234-byte image, a **378,366,779-byte (378.4 MB / 360.8 MiB)
delta** — the worst case, because a bare base shares none of the C libraries.
In the real OpenCode image the Python step is a **268 MB layer**
(`docker history`), because Node/git already provide `libssl`, `libstdc++` and
the other shared objects the apk packages need. Both numbers are below the
+400 MB budget. Installed site-packages are 156.3 MiB:

| Package | Installed |
| --- | --- |
| onnxruntime (+ 14.4 MiB shared library, 10.4 MiB openblas) | 34.0 MiB |
| pandas (markitdown's xlsx extra) | 23.8 MiB |
| numpy | 19.0 MiB |
| sympy | 16.5 MiB |
| pdfminer.six | 9.1 MiB |
| reportlab | 4.7 MiB |
| lxml | 4.2 MiB |
| magika (incl. bundled model) | 3.3 MiB |
| cryptography | 3.2 MiB |
| python-pptx | 2.5 MiB |
| python-docx | 2.3 MiB |
| pillow | 2.0 MiB |
| remainder (markitdown, mammoth, pdfplumber, requests, …) | 31.7 MiB |

The markitdown family — markitdown, magika, onnxruntime, numpy, sympy and the
shared libraries — is about 102 MB, plus 24 MB for pandas through the xlsx
extra. That is the item to cut first if the budget ever tightens; dropping the
`xlsx` extra (and the pandas path in `read_document`) would be the smallest
functional loss.

Development uses `pnpm run setup:python` (Node only, no new JS dependency;
creates `.venv` from `python3` 3.12+, installs all three locks with `--no-deps`,
verifies the imports, refuses a venv whose major/minor differs from the host)
and `pnpm run python:check` (offline; skips when `.venv` is absent). The
package's `pnpm test` then also runs the Python unit tests through that venv
and skips them with one line when it is missing. On Apple
silicon the cp314 native wheels need macOS 14+; the download path was verified
for `macosx_14_0_arm64` (45 wheels).

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
| RAM watchdog | A `mem_limit` kills one container; nothing watches host-level pressure | `deploy/host/ram-watchdog.sh` + its timer read `MemAvailable` and stop only the `opencode` service below a threshold, with hysteresis. Compose has no supervisor and cannot restart a whole stack on host pressure. |
| Total stack ceiling | Per-container only | `systemd` slice accounting for the docker service, or the VPS size. |
| Swap / overcommit | Not configured here | `vm.swappiness`, `vm.overcommit_memory`; decide whether the agent may swap. |
| Disk quota for the artifact volume | Not expressible for a named volume | XFS project quota, ext4 `prjquota`, or a dedicated volume; monitor free space. |
| dind image garbage | Nothing collects images | `deploy/host/dind-gc.sh` + its daily timer prune **inside** the rootless daemon (`DOCKER_HOST=tcp://dind:2375`), bounded by a 168 h retention and the 4 GiB loop. |
| Kernel OOM score | Not expressible | `oom_score_adj` via the systemd unit if the BFF must survive the agent. |
| Backups | Not in this file | `deploy/remote/backup.sh`: one timestamped archive of `opencode-data`, `opencode-config`, `workspace`, the artifact volume and `.env`, with manifest, checksums, retention and `--restore-check` ([`28-operations.md`](28-operations.md)). |

The predecessor kept `ram-watchdog.sh` and `dind-guard.sh` as host scripts. They
stay host scripts: a container that watches its own cgroup cannot enforce a host
policy, and Compose has no hook that runs when the host runs out of memory.

### Host guards (`deploy/host/`)

The scripts are POSIX `sh`, run on the host and are installed by
`deploy/host/install.sh`; the units are rendered with `@STACK_DIR@` replaced, so
a stack outside `/opt/stacks/openchat` gets correct `ExecStart=` paths.

| Piece | Input | Behaviour |
| --- | --- | --- |
| `ram-watchdog.sh` | `MemAvailable` from `/proc/meminfo` (or `--meminfo FILE`), `--low` MiB, `--high` MiB | below `--low` stops **only** the `opencode` compose service and writes `$STACK_DIR/ram-watchdog.state` (0600); above `--high` starts it again only when that state file exists; inside the band it changes nothing |
| `dind-gc.sh` | `--max-age-hours` (168), `--network openchat_dind`, `--image` (the digest the dind profile pins) | one-shot container on the internal `dind` bridge runs `image prune -af --filter until=168h`; exits 0 when dind is not running |
| `artifact-usage.sh` | `df -P -k` on `$STACK_DIR/disks/artifacts`, `--warn-percent` (90) | prints one warning line at or above the threshold; deletes nothing |

The guards never stop `bff`, `code-host`, `artifact-host` or the edge proxy, never
restart the Docker daemon and have no `OnFailure=` handler (every plausible
handler would stop or restart Docker). The units carry no `After=`/`Requires=` on
`docker.service`. A missing meminfo, a missing compose file, an unreadable `df` or
a stopped dind logs and exits `0`: a guard that takes the host down when its input
is missing is worse than no guard.

**Measured baseline** (#44 physical review, 2026-11-18 16:15 UTC, 56 min after the
second deploy): `MemTotal` **7648 MiB**, `MemAvailable` **3688 MiB**, 16 GiB swap
with 2.7 GiB used and `si/so` ≈ 0, the four application containers at **183 MiB**
total, compose memory caps summing **3456 MiB** without dind. The box is not
under pressure at baseline; the guard exists for the next build or agent burst,
not for the happy path.

**Thresholds and why.** `--low 900 MiB`, `--high 1200 MiB`:

- The `opencode` cap is 1536 MiB. Once `MemAvailable` is under 900 MiB, the host
  cannot satisfy one more meaningful growth step plus page cache for the BFF
  (512 MiB cap) without reclaiming hot file pages or swapping. Stopping
  `opencode` is the smallest action that removes the agent's growth path while
  leaving login, SSE and artifacts running.
- 1200 MiB is a 300 MiB hysteresis band. Reclaiming 300 MiB of page cache is an
  ordinary fluctuation, so without the band a busy host would stop and start
  `opencode` on consecutive ticks. Restarting at 1200 also leaves 300 MiB above
  the stop point for the service to start again.
- Both values are inputs, not constants tied to a clock or a PID. The 60 s timer
  only decides *when* the value is read; the decision is `available < low` /
  `available > high` and the state file. A test drives `--low 1500 --high 1800`
  against the same 1000 MiB fixture and gets a stop, while the defaults stay
  silent.

**The dind GC shape.** The rootless daemon publishes no port; `tcp://dind:2375`
resolves only on the internal `openchat_dind` bridge. A host-side Docker CLI
cannot reach it, so the GC runs a one-shot container on that bridge with the
`dind` profile's own pinned image as the CLI:

```
docker run --rm --network openchat_dind \
  -e DOCKER_HOST=tcp://dind:2375 \
  --entrypoint docker docker:27-dind-rootless@sha256:e2ac8e8f… \
  image prune -af --filter until=168h
```

168 h is the retention maximum; `image prune` never removes images in use, and the
4 GiB `disks/dind.img` remains the hard bound. The daily timer is enough because
the loop is already the cap; the hourly artifact check is separate.

**Install and remove** (on the host, from the synced source tree):

```
sudo deploy/host/install.sh --stack-dir /opt/stacks/openchat
# installs $STACK_DIR/bin/{ram-watchdog,dind-gc,artifact-usage}.sh,
# renders six units into /etc/systemd/system, daemon-reload,
# enables openchat-{ram-watchdog,dind-gc,artifact-usage}.timer

deploy/host/ram-watchdog.sh --stack-dir /opt/stacks/openchat --dry-run
deploy/host/dind-gc.sh --dry-run
deploy/host/artifact-usage.sh --stack-dir /opt/stacks/openchat
systemctl list-timers 'openchat-*'
journalctl -u openchat-ram-watchdog -n 20

sudo deploy/host/install.sh --uninstall
# disables the timers, removes the six units and the three guard scripts.
# Keeps the state file, $STACK_DIR/bin (the deploy's own helpers), .env, the
# disk images and every container. Nothing is stopped and Docker is untouched.
```

The timers are `openchat-ram-watchdog.timer` (60 s), `openchat-dind-gc.timer`
(daily, persistent) and `openchat-artifact-usage.timer` (hourly, persistent).
`deploy/remote/deploy.sh --with-guards` runs `deploy/host/install.sh` from the
synced source tree after the swap and the Caddy fragment, so a deploy can
install and enable them; without the flag nothing on the host changes, because
a watchdog that stops `opencode` is a host-level decision. `--uninstall`
disables the three timers and removes their six unit files together with the
two stack units.

**Unproven.** No guard was run against a live host for this change: no systemd
unit was started, no VPS memory was dropped, and the "only `opencode` stops"
rehearsal remains issue #36's acceptance item. Everything above is pinned by
`apps/server/test/host-guards.test.ts` against stubbed `docker`, `systemctl`, `df`
and `install`; the units were rendered into a temp directory, not loaded by
systemd. The dind GC cannot be proven while the `dind` profile is off:
`MemAvailable` measured 3688 MiB is below the 6144 MiB gate `deploy.sh` requires
for `--with-dind`, so the daemon and its bridge were not running. The artifact
check is alert-only; no `prjquota`/XFS quota exists on `/`, and the 2 GiB loop is
the only hard bound.


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

## Local tunnel mode

The same image runs when OpenCode is a process behind an SSH forward instead of
a container on the deployment host. The tunnel is a **host concern**: no BFF
tunnel mode, no second URL, no tunnel-specific route.

1. Open the forward next to the BFF:
   `ssh -N -L 4096:127.0.0.1:4096 owner@code.example.com` (`-N`: no shell).
2. Set exactly `OPENCODE_URL=http://127.0.0.1:4096`: the forwarded loopback
   port, not the remote name, so credentials stay in
   `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` and never in the URL.
3. Keep it alive with systemd, or `autossh -M 0 -N -L 4096:127.0.0.1:4096
   owner@code.example.com` under a LaunchAgent with `KeepAlive` true; the BFF
   only ever sees a refused connection.

While the tunnel is down:

- `/healthz` stays `200` (process liveness), so no restart loop follows.
- `/api/info` answers `200` with `host.reachable: false`, `server: null` and
  empty `models`/`agents`; other API routes fail as for any host outage, with
  no `502 tunnel-down` branch.
- The event stream ends with the upstream subscription; the browser reconnects
  after the BFF's `retry: 2000` frame and the transcript re-reads its snapshot.
- The host banner appears when the stream drops, and clears when it reopens and
  `/api/info` says reachable — no page reload, draft preserved.

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
| `apps/server/test/host-guards.test.ts` | watchdog: one stop below `--low` with a 0600 state file, no second stop, one start above `--high` and state cleared, band silence, custom thresholds, missing/corrupt meminfo and missing compose exit 0 with no docker call, dry run, space-bearing stack path as single argv; dind GC: no prune when dind is down, exact one-shot prune command, dry run; artifact usage: 91 % warning and 50 % silence; install/uninstall files and systemctl calls, dry run; units have no `docker.service` ordering and no `OnFailure=`; the doc states the baseline, thresholds and unproven parts |

## Manual acceptance (not run here)

1. `docker build -f deploy/Dockerfile.bff .` for all three images, then
   `docker compose config -q` with a filled `.env`.
2. `docker compose up -d` with `OPENCODE_URL` at a real service: `docker compose
   ps` healthy, `/healthz` 200, login, SSE, one artifact, the Code frame.
3. `docker compose --profile tools --profile dind up -d toolbox dind`, then
   `docker compose exec toolbox docker run --rm hello-world`.
4. `deploy/swap.sh --dry-run`, then a real swap with a deliberately broken
   candidate to watch the rollback on the host.
5. Install the host guards (`deploy/host/install.sh --stack-dir /opt/stacks/openchat`),
   run each script once with `--dry-run`, then drop `MemAvailable` artificially
   and watch only `opencode` stop and return on the next high tick. The dind GC
   needs `--with-dind` and therefore the 6144 MiB gate; it remains unproven until
   the predecessor stack is gone.
