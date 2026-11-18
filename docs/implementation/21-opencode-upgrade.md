# 21 — OpenCode upgrades: policy, path, rollback

**Status:** 2026-11-18. Covers issue #38 (parity gap 5). The stack pins the
OpenCode server image and the client range; this page says how a new version
reaches the host, what is verified before the swap, and how to go back. The
decision record itself belongs to `docs/decisions/` (owner-owned) and is the one
part of #38 this page does not supply.

## What is pinned today

| Place | Value | Why |
|---|---|---|
| `deploy/Dockerfile.opencode` | `ghcr.io/anomalyco/opencode:2.3.2@sha256:be07cc4a…015f5a` | the derived image builds from an immutable multi-arch index; the tag alone could be re-pointed |
| `compose.yaml` | `${OPENCODE_IMAGE:-ghcr.io/anomalyco/opencode:2.3.2}` | the plain upstream image used when the derived image is not built (local dev) |
| `packages/opencode/src/index.ts` | `SUPPORTED_OPENCODE_MAJOR` | the Code surface warns on a major skew instead of blocking |
| `apps/server/src/code.ts` | `expectedVersion` in `/api/code/status` | machine-readable form of the same label |

Measured on the live host: OpenCode 2.3.2 exposes **no HTTP authentication**.
The protection is network isolation (no published port, two private bridge
networks, reachable only through the BFF and the Code host), documented in
[`20-remote-deploy.md`](20-remote-deploy.md). An upgrade does not change that.

## Policy

1. **No auto-update.** Nothing pulls a new OpenCode on its own: the base is a
   tag *and* an index digest, and `deploy.sh` builds from the checked-out tree.
   Watchtower (the predecessor's updater) never sees locally tagged
   `openchat-*:<sha>` images.
2. **Upgrade on demand, on a minor.** A patch or minor is adopted when there is
   a reason (fix, feature, security note), not on a calendar. A **major** bump
   is a code change first: `SUPPORTED_OPENCODE_MAJOR` and the `@opencode/client`
   range move together with it.
3. **Digest pin, tag for humans.** The Dockerfile carries both, so a reader sees
   the version and the build sees an immutable index. Bumping means resolving a
   new digest, not editing a number in two places by hand.
4. **Base rebuilds are deploy-driven.** There is no nightly rebuild job: the
   derived image is rebuilt whenever a deploy builds it, which happens on every
   deploy. A rebuild without an OpenCode bump therefore only picks up Alpine
   package updates for `git`, `curl`, `nodejs` and the Docker CLI — it changes
   the image, not the pinned base.

## Evidence before an upgrade

- The upstream changelog for the target version, read for breaking API changes
  the BFF or the Code host depend on (`/api/session`, `/event`, `/global/*`).
- `pnpm run gates:fast` green on the candidate tree.
- One local smoke against the new image: `docker build -f deploy/Dockerfile.opencode .`
  and `docker run --rm --entrypoint opencode <image> --version` (the Dockerfile
  already runs the second as a build assertion).

## The upgrade sequence

1. Resolve the index digest of the target:

   ```
   docker buildx imagetools inspect ghcr.io/anomalyco/opencode:<version> \
     | sed -n 's/^Digest: *//p'
   ```

2. Update the two pins and, only for a major bump, the supported label:

   - `deploy/Dockerfile.opencode`: `ARG OPENCODE_BASE=ghcr.io/anomalyco/opencode:<version>@sha256:<digest>`
   - `compose.yaml`: the `OPENCODE_IMAGE` default tag
   - `packages/opencode/src/index.ts`: `SUPPORTED_OPENCODE_MAJOR` (major only)
   - `package.json` / `pnpm-lock.yaml`: the `@opencode/client` range (major only)

3. Run the gates and commit; the deploy uses the commit as the image tag.

   ```
   pnpm run gates:fast
   deploy/remote/deploy.sh --tag "$(git rev-parse --short HEAD)" --expect-version 2.0.0
   ```

   `--expect-version` checks the **BFF** version (`/healthz`), not OpenCode; it
   guards against swapping in a half-built BFF. The OpenCode version is checked
   in the next step.

4. Verify the candidate on the live host:

   ```
   curl -s -H "Cookie: __Host-oc_session=<session>" https://chat.<domain>/api/info
   curl -s -H "Cookie: __Host-oc_session=<session>" https://chat.<domain>/api/code/status
   ```

   Required: `/api/info` reports `server.version` equal to the new version,
   `artifacts.available` true, `host.reachable` true; `/api/code/status` returns
   `matches: true` (a major skew returns `matches: false` and the Code surface
   shows its warning without blocking the frame); the Code ticket exchange
   still answers `302` and the Code surface `200`; chat SSE and Code SSE carry
   no `Content-Encoding`.

   `deploy/remote/deploy.sh` already refuses to finish when the swap probe
   fails; a failed probe restores `previous` by itself.

5. Rollback, if a later check fails:

   ```
   ssh root@<host> 'cd /opt/stacks/openchat && \
     OPENCHAT_TAG="$(cat previous/tag)" COMPOSE_PROFILES=opencode \
     bash "src/$(cat previous/tag)/deploy/swap.sh" --stack-dir /opt/stacks/openchat \
       --release "$(readlink previous)"'
   ```

   `previous/tag` is written by `render_release` next to the rendered compose
   file; the image tag is not part of the compose render (it stays
   `${OPENCHAT_TAG}`), so the release has to record it for a rollback that
   starts after a restart.

## What the mismatch warning covers

`/api/code/status` returns `version`, `expectedVersion` and `matches`
(`apps/server/src/code.ts`, pinned in `apps/server/test/code.test.ts`). The Code
surface renders `code.versionMismatch` above the frame when `matches` is false
(`apps/web/test/code-page.test.tsx`). That is the operator-visible signal that a
host was moved without moving the supported label; it is a warning, not a
block, because a patch-level skew is expected between deploys.

## Rehearsal status

The sequence above is documented, not yet rehearsed end to end on the VPS: that
needs a second upstream version pulled next to the running one, and the owner
has not scheduled the window. Rollback itself was exercised in the 2.0.0
deployment work (the `swap.sh` `--previous` restore path, pinned by
`apps/server/test/remote-deploy.test.ts`).
