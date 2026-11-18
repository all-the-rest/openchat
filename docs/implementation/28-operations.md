# 28 — Operations: signals, backups, upgrade and rollback

**Status:** 2026-11-18. The monitoring and backup half of issue #9 (M7). It adds
two host scripts, `deploy/remote/status.sh` (read-only probes) and
`deploy/remote/backup.sh` (archive, retention, restore-check), installs both as
`/opt/stacks/openchat/bin/*` on the next deploy, and documents the recovery
sequences. It does not change the stack: no new container, no new port, no
external monitoring service.

This page is the runbook. It builds on
[`14-deployment.md`](14-deployment.md) (compose stack, `deploy/swap.sh`,
secrets) and [`20-remote-deploy.md`](20-remote-deploy.md) (SSH driver, disks,
Caddy). Every command below exists in this repository or in the host's standard
tool set; nothing here is a proposed flag.

## What runs where

| Script | Runs on | Needs | Writes |
| --- | --- | --- | --- |
| `deploy/remote/deploy.sh` | owner's laptop | `ssh`, `rsync` | everything on the host |
| `deploy/remote/status.sh` | the host | `docker`, `curl`, `df` | nothing |
| `deploy/remote/backup.sh` | the host | `tar`, `sha256sum` or `shasum`; `docker` only to locate a named volume | one archive + two sidecars in `--out-dir` |
| `deploy/remote/mount-disks.sh` | the host | `mount`, `mkfs.ext4` | mounts, chown, `.openchat-disk` markers |
| `deploy/swap.sh` | the host | `docker`, `curl` | `current`/`previous` links, containers |

Host paths used below: stack `/opt/stacks/openchat`, secrets
`/opt/stacks/openchat/.env`, compose project `openchat`, host
`root@reisinger.pictures`.

## Signals

`status.sh` prints one line per signal and exits `0` when every signal is `ok`
or `warn`, `1` when one is `FAIL`, and `2` on a usage error. It starts no
container, touches no file and needs no credential.

```bash
# on the host
/opt/stacks/openchat/bin/status.sh

# from the laptop (the exit code crosses SSH unchanged)
ssh root@reisinger.pictures /opt/stacks/openchat/bin/status.sh
```

Example of a healthy stack:

```
release    ok   current -> releases/20261118T141759Z (tag 20261118T141759Z)
containers ok   5/5 running, 5 healthy
uptime     ok   Up 3 days (healthy); restarts 0
healthz    ok   200 ok:true, mode live, version 2.2.0
restarts   ok    artifact-host=0 bff=0 code-host=0 documents=0 opencode=0
disk       ok   warn 85%, crit 95%: / 41% (26.0/48.0 GiB free), stack 41% ...
ram        ok   2740 MiB of 3900 MiB available (70%)
```

| Signal | Probe | `warn` | `FAIL` | What it means |
| --- | --- | --- | --- | --- |
| `release` | `current` is a link into `releases/` and carries a `tag` file | — | link missing, target missing | The stack is not pointing at a release a rollback can name. |
| `containers` | compose label `com.docker.compose.project=openchat`, state and `.State.Health` per container | `starting` health | expected service missing, not `running`, or `unhealthy` | A compose health check is failing or a container stopped. Expected services default to `bff,code-host,artifact-host,documents,opencode` (`--expect`). |
| `uptime` | BFF `Status` and `RestartCount` | — | BFF not up | Informational: how long the BFF has run. A reset with restarts `0` was a deploy or manual restart, not a crash. |
| `healthz` | `GET http://127.0.0.1:8787/healthz` (`BFF_PORT` from `.env`) | `mode:fake` on a deployed stack | not `200`, or no `{"ok":true}` | The BFF process answers. **Liveness only**: OpenCode reachability is not part of it ([`03`](../architecture/03-auth-deployment.md), [`10`](10-host-status.md)). |
| `restarts` | `.RestartCount` per container | — | any container above `--restart-max` (default 3) | A restart loop. Look at that container's logs (`--logs`). |
| `disk` | `df -P -k` on `/`, the stack root and `disks/{artifacts,workspace,dind}` | ≥ `--disk-warn` (85%) | ≥ `--disk-crit` (95%) | The loop images are 2/4/4 GiB and fill quietly; a full artifacts image turns writes into `500 internal_error`. |
| `ram` | `MemAvailable`/`MemTotal` from `/proc/meminfo` (or `--meminfo FILE`) | below `--ram-warn` (10%) | below `--ram-crit` (5%) | Host pressure. Below 900 MiB the opt-in RAM watchdog stops `opencode`; this line explains why the Code surface is gone. A missing `/proc/meminfo` is `skip`, not a failure. |
| `logs` | `docker logs --tail N` for containers the probes flagged | any failing container | — | Only with `--logs N` (default `0`). It tails what is already broken; it is not a second check. |

Off-host uptime is a client-side check, not a service: from any other machine,
`curl -fsS https://chat.reisinger.pictures/healthz`. An external pinger is a
hosting decision and is deliberately not part of this stack.

`/healthz` says nothing about OpenCode. Use the login page or
`/api/info` behind the session for the upstream; the deploy's own validation in
`deploy/swap.sh` is the unauthenticated version of that probe.

## Backup

`backup.sh` archives five sources into **one** timestamped file outside the
stack:

| Source | Host path | Why |
| --- | --- | --- |
| `.env` | `/opt/stacks/openchat/.env` | the credential that makes the restored stack the same stack |
| `opencode-config/` | `/opt/stacks/openchat/opencode-config` | seeded MCP entries and agent edits |
| `opencode-data/` | mountpoint of volume `openchat_opencode-data` | OpenCode sessions, config, storage |
| `artifacts/` | `/opt/stacks/openchat/disks/artifacts` | user documents |
| `workspace/` | `/opt/stacks/openchat/disks/workspace` | workspace and `chats/` working files |

The archive contains `manifest.txt` (kind, archive path, bytes, file count and
source per entry), `checksums.sha256` (one sha256 per payload file) and the five
sources with their modes, so `.env` stays `0600`. Beside the archive sit
`<name>.sha256` (the archive's own digest) and `<name>.manifest.txt`.
No value from `.env` is read into the manifest or printed.

```bash
# plan only: prints the five sources, sizes, free-space need and retention
/opt/stacks/openchat/bin/backup.sh --stack-dir /opt/stacks/openchat --dry-run

# the real run (default --out-dir /var/backups/openchat, default --keep 14)
/opt/stacks/openchat/bin/backup.sh --stack-dir /opt/stacks/openchat

# verify the newest archive without touching live data
/opt/stacks/openchat/bin/backup.sh --stack-dir /opt/stacks/openchat --restore-check
```

Behaviour that matters during an incident:

- **Refuses instead of guessing.** A missing, unreadable or symlinked source
  stops the run before anything is written. The archive target itself must not
  be inside the stack.
- **Free space is a precondition.** The script compares the payload size with
  `df` on `--out-dir` and refuses when the archive would not fit. A backup that
  fills the disk is an outage, not a backup.
- **Symlinks are archived as symlinks.** A link inside the workspace that
  points at `/etc` is stored as a link and never read; only the five named
  sources are read.
- **Retention deletes only its own files.** `openchat-backup-YYYYMMDDTHHMMSSZ.tar.gz`
  plus its exact sidecars; anything else in `--out-dir` is left alone. The
  newest `--keep` archives stay.
- **A live backup can be inconsistent.** The workspace and the volume are read
  while the stack runs. If a file changes mid-tar, the run fails, removes the
  partial archive and tells you to use a quiet window. Prefer a time with no
  agent job (the cron example below is 03:15 UTC).
- **It costs one read of every byte.** Two loop images plus the volume are
  hashed and tarred in one run; on this host that is several GiB of I/O.

Capacity check on this host: `/` had 48 GiB free; the five sources are capped
at about 4 GiB (workspace) + 2 GiB (artifacts) + `< 1 GiB` (OpenCode data).
Fourteen copies do **not** fit if the disks are full. Start with `--keep 7` and
watch `df`, or point `--out-dir` at a larger mounted volume. Storage planning is
an owner decision; the script only refuses to make it worse.

Scheduling is owner-run. No timer is installed by this change; a root crontab
entry with the stable path:

```cron
15 3 * * * /opt/stacks/openchat/bin/backup.sh --stack-dir /opt/stacks/openchat --keep 7 >> /var/log/openchat-backup.log 2>&1
```

## Restore

1. **Verify first.** `--restore-check` extracts into a fresh temporary
   directory, checks the archive digest (when the sidecar exists), refuses
   absolute paths, `..` segments and unexpected top-level entries, and verifies
   every payload checksum:

   ```bash
   /opt/stacks/openchat/bin/backup.sh --stack-dir /opt/stacks/openchat --restore-check
   ```

   A failing checksum means the archive or the snapshot is not trustworthy; take
   a new backup and do not restore this one.

2. **Stop only this stack.** The data stays where it is:

   ```bash
   cd /opt/stacks/openchat
   docker compose --project-name openchat --env-file .env \
     --file current/compose.yaml --profile "*" stop
   ```

3. **Extract into a scratch directory** (never over live data):

   ```bash
   archive=/var/backups/openchat/$(ls -1t /var/backups/openchat | grep -E '^openchat-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz$' | head -n 1)
   scratch=$(mktemp -d)
   tar -xzf "$archive" -C "$scratch"
   ls -la "$scratch"
   ```

4. **Put the five sources back.** `rsync --delete` makes the target match the
   archive; the volume path comes from docker, not from this page:

   ```bash
   volume=$(docker volume inspect --format '{{.Mountpoint}}' openchat_opencode-data)
   install -m 600 "$scratch/.env" /opt/stacks/openchat/.env
   rsync -a --delete "$scratch/opencode-config/" /opt/stacks/openchat/opencode-config/
   rsync -a --delete "$scratch/opencode-data/" "$volume/"
   rsync -a --delete "$scratch/artifacts/" /opt/stacks/openchat/disks/artifacts/
   rsync -a --delete "$scratch/workspace/" /opt/stacks/openchat/disks/workspace/
   rm -rf "$scratch"
   ```

5. **Repair ownership and start the release that was current.** A stopped stack
   is not started by `swap.sh` (it validates a running one), so use the release's
   own compose file with the same environment the deploy uses:

   ```bash
   bash /opt/stacks/openchat/bin/mount-disks.sh --stack-dir /opt/stacks/openchat
   cd /opt/stacks/openchat
   OPENCHAT_TAG=$(cat current/tag) COMPOSE_PROFILES=opencode \
     docker compose --project-name openchat --env-file .env \
     --file current/compose.yaml up -d --wait --wait-timeout 120
   ```

6. **Verify.** `/opt/stacks/openchat/bin/status.sh` must exit `0`, and the login
   plus one artifact read must work. If the image of that release was pruned,
   check out its tag and redeploy from that checkout
   (`deploy/remote/deploy.sh --tag <tag> --expect-version "$(cat VERSION)"`):
   the driver syncs the source tree it runs in, not the tag's.

Restoring an old `.env` also restores the secrets of that day. If secrets were
rotated since, rotate again after the restore (next section).

## Upgrade

This stack has no registry: an upgrade is a git checkout plus a host-side
rebuild. `deploy.sh --tag` selects the image tag, `--expect-version` makes the
swap fail unless `/healthz` reports that version, and `deploy.sh` rolls back to
`previous` by itself when validation fails.

```bash
# on the laptop, from a clean checkout
git fetch --tags
git checkout <release-tag>
cat VERSION                                  # the value for --expect-version
deploy/remote/deploy.sh --dry-run --tag <release-tag> --expect-version "$(cat VERSION)"
deploy/remote/deploy.sh --tag <release-tag> --expect-version "$(cat VERSION)"
```

Then on the host:

```bash
/opt/stacks/openchat/bin/status.sh
```

The deploy's own validation already probed `/healthz` and `/api/info`; `status.sh`
confirms the container set, restart counts, disk and RAM afterwards.

### Rollback

Fast path, no rebuild: point `swap.sh` at the release `previous` names, with the
tag that release recorded.

```bash
ssh root@reisinger.pictures
cd /opt/stacks/openchat
tag=$(cat previous/tag)
version=$(cat "src/$tag/VERSION")
env OPENCHAT_TAG="$tag" COMPOSE_PROFILES=opencode \
  bash "src/$tag/deploy/swap.sh" --stack-dir /opt/stacks/openchat \
  --release "$(readlink previous)" --expect-version "$version"
```

From the laptop, the same result through the driver (it rebuilds the old tag's
images from the synced source):

```bash
git checkout <previous-tag>
deploy/remote/deploy.sh --tag <previous-tag> --expect-version "$(cat VERSION)"
```

`swap.sh` moves `current` to the candidate and, on a failed probe, back to the
release that ran before; a failed rollback exits non-zero and leaves the links
for a human, never a half-swapped stack.

## Rotate secrets

The keys live only in `/opt/stacks/openchat/.env` (mode `0600`). Rotation is an
owner action; `env-bootstrap.sh` deliberately refuses to overwrite the file.

| Key | Read by | Effect |
| --- | --- | --- |
| `SESSION_SECRET` | bff | every login session is invalidated |
| `CODE_TICKET_SECRET` | bff, code-host | open Code cookies are invalidated |
| `ARTIFACT_SIGNING_KEY` | bff, artifact-host | outstanding signed artifact URLs stop working |
| `ARTIFACT_INTERNAL_TOKEN` | bff, opencode (artifact MCP entry) | the agent's artifact tool fails until both sides carry the new value |
| `DOCUMENTS_TOKEN` | documents, opencode (`opencode-config/opencode.json`) | document jobs fail until both sides carry the new value |
| `OPENCODE_PASSWORD` | bff, code-host, opencode | Basic credential used by the BFF and Code host |
| `OPENCHAT_PASSWORD` / `OPENCHAT_PASSWORD_HASH` | bff | exactly one shape must be set; both or neither fails the boot |

```bash
cd /opt/stacks/openchat
umask 077
cp -p .env ".env.$(date -u +%Y%m%dT%H%M%SZ).bak"
key=SESSION_SECRET
value=$(openssl rand -hex 32)
awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' \
  .env > .env.new
chmod 600 .env.new
mv .env.new .env
unset value
```

Restart the services that read the key (the whole stack is also fine, but
`opencode` is the expensive one):

```bash
cd /opt/stacks/openchat
OPENCHAT_TAG=$(cat current/tag) COMPOSE_PROFILES=opencode \
  docker compose --project-name openchat --env-file .env \
  --file current/compose.yaml up -d --force-recreate bff artifact-host
```

`ARTIFACT_INTERNAL_TOKEN` and `DOCUMENTS_TOKEN` are also baked into the seeded
`opencode-config/opencode.json`. Rotate them there in the same window, for
example (the token is hex, so `sed` is literal):

```bash
new=$(openssl rand -hex 32)
sed -i "s/\"DOCUMENTS_TOKEN\": \"[^\"]*\"/\"DOCUMENTS_TOKEN\": \"$new\"/" \
  /opt/stacks/openchat/opencode-config/opencode.json
unset new
```

Then restart `bff artifact-host documents opencode` (and `code-host` for
`CODE_TICKET_SECRET` or `OPENCODE_PASSWORD`) and run `bin/status.sh`. Take a
backup after a rotation: the new `.env` is what a restore must keep.

## Common failures

| Symptom | First commands | What to do |
| --- | --- | --- |
| SSH times out | `ssh -o ConnectTimeout=5 root@reisinger.pictures true` | The site may still be up; use the provider console. Nothing on the laptop can fix an unreachable host. |
| `disk FAIL` | `df -h / /opt/stacks/openchat/disks/*`; `docker system df` | Trim the shared build cache with `docker builder prune -f --keep-storage 4GB` (the deploy does this too). Artifact eviction is an owner decision; never delete `disks/*.img` or a mounted image's contents. |
| Certificate expired or ACME failing | `docker logs --tail 50 caddy`; `docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` | Fix DNS or port 80/443 reachability (owner/provider), then `docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. The stack's own blocks are unaffected by the deploy. |
| `containers FAIL` | `bin/status.sh --logs 100`; `docker logs --tail 200 openchat-bff-1` | Read the flagged container's logs. `restart: unless-stopped` brings it back; a repeated `restarts` failure is a crash loop, not a transient. |
| `healthz FAIL`, container up | `curl -fsS http://127.0.0.1:8787/healthz`; `docker logs --tail 100 openchat-bff-1` | The BFF is alive but not answering; check its log for a failed boot (missing secret is a start failure, not a default). |
| `release FAIL` | `readlink /opt/stacks/openchat/current`, `ls releases` | A half-finished swap. Roll back with the `previous` release or redeploy the recorded tag. |
| Mounts missing after a reboot | `systemctl status openchat-disks.service`; `bash /opt/stacks/openchat/bin/mount-disks.sh --stack-dir /opt/stacks/openchat` | `disks-ready` refuses to start the stack and the boot guard stops it. Mount first, then start with the compose command from "Restore" step 5. |
| Only the Code surface is down | `bin/status.sh`; `docker logs --tail 100 openchat-opencode-1`; `cat /opt/stacks/openchat/ram-watchdog.state` | `/healthz` stays `200` by design. The state file explains a watchdog stop; otherwise check memory first (`ram` line), then the container log. |
| Version skew after an upgrade | `swap.sh` output, `bin/status.sh` | The deploy should have rolled back. If it did not, use "Rollback" above; never leave `current` on a release that does not report the expected version. |

## Upgrade and restore test

Locally scriptable and network-free (part of `pnpm run deploy:test`, called by
CI's fast job):

```bash
pnpm run deploy:test
```

`deploy/remote/test/upgrade.test.sh` runs the real `deploy/swap.sh` against a
temporary stack with a fake `docker` and a fake `curl`: release A → release B →
rollback to A, and a candidate whose `/healthz` does not report
`--expect-version`, which must leave `current` on A. It also checks that
`deploy/remote/deploy.sh --dry-run` plans the tag and the version check. This is
the whole upgrade/rollback state machine; only the SSH and container runtime
are stubbed.

Owner-run, because they need the live host, real images and a browser:

1. `deploy/remote/deploy.sh --dry-run --tag <tag> --expect-version "$(cat VERSION)"`
2. `deploy/remote/deploy.sh --tag <tag> --expect-version "$(cat VERSION)"`, then
   `bin/status.sh` exits `0`.
3. `bin/backup.sh --restore-check` passes for the backup taken before the
   upgrade.
4. Rollback via `previous`, then forward again: both directions end with
   `status.sh` exit `0` and one successful login.
5. Restore drill into a scratch directory on the host (step 3 of "Restore"),
   then a full restore in a quiet window when a real rollback is acceptable.

## Tests and deliberate omissions

| File | Pins |
| --- | --- |
| `deploy/remote/test/backup.test.sh` | dry-run writes nothing; archive paths, modes and manifest; sidecar digest; checksum mismatch detected; retention keeps N and spares foreign files; missing/symlinked source refused; inner symlink not followed; restore-check leaves live data alone; `--out-dir` inside the stack refused |
| `deploy/remote/test/status.test.sh` | one line per signal; healthz 500, unhealthy/exited container, restart threshold, disk and RAM thresholds exit `1`; `--logs` tails only failing containers; no write under the stack |
| `deploy/remote/test/upgrade.test.sh` | A → B → rollback; `--expect-version` rollback; deploy dry run plans tag and version |

Not automated, on purpose:

- **No backup timer.** Scheduling is an owner choice (cron example above); a
  timer unit would need install/uninstall plumbing in a deploy that is already
  live.
- **No external uptime service.** It would add a third party and a credential.
  Off-host `curl https://chat.<domain>/healthz` from the owner's machine covers
  the same question.
- **`status.sh` does not probe `/api/info`.** An unauthenticated probe can only
  prove the auth guard (see `swap.sh`); the login page and the deploy validation
  are the real upstream checks.
- **No live restore in CI.** The archive format and the restore path are tested
  against fixtures; a real restore needs the host's volume mountpoint and a stop
  window.
- **No artifact eviction.** `bin/status.sh` warns; deleting user documents is an
  owner decision, never a timer's.
