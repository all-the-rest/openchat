# 16 — Release mechanics: version, changelog, images

**Status:** 2026-11-18. Issue #19, milestone v2.0. This slice builds and
dry-runs the machinery; no tag was created, no image was pushed and no release
was published. The workflow is validated statically — by parsing it in
`apps/server/test/release-workflow.test.ts` — never by running GitHub Actions.
Deployment itself is [`14-deployment.md`](14-deployment.md).

## What ships

| Piece | Path | What it does |
| --- | --- | --- |
| Version source | `VERSION` | the one version every released package mirrors |
| Version + changelog CLI | `scripts/release.ts` | `version`, `bump`, `changelog`, `check` |
| Version rules | `scripts/release/version.ts` | semver bump, mirrors, lockfile importers, dry run |
| Changelog rules | `scripts/release/changelog.ts` | commit grouping, deterministic dates, section replace |
| Pre-tag check | `scripts/release/check.ts` | dirty tree, agreement, changelog-vs-tag, gates, verify |
| Workflow | `.github/workflows/release.yml` | gates, multi-arch images, SBOM/provenance, release notes |
| Changelog | `CHANGELOG.md` | Keep a Changelog; starts empty until 2.0.0 is prepared |

## One version, one source

`VERSION` at the repository root is authoritative. These files mirror it:

- `apps/server/package.json`
- `apps/code-host/package.json`
- `apps/artifact-host/package.json`
- `packages/artifact-tool/package.json` — the MCP handshake reads its `version`
  at runtime; the first bump inserts the field
- `packages/code-ticket/package.json`
- `packages/contracts/package.json`
- `packages/opencode/package.json`
- `apps/server/src/app.ts` — `SERVER_VERSION`, the value `/healthz` reports and
  `deploy/swap.sh --expect-version` compares
- `pnpm-lock.yaml` — only when an importer actually records a version. pnpm 11
  does not today; the field is updated if a future lockfile gains one.

`apps/web` is intentionally not versioned: its build is copied into the BFF
image, so the BFF version covers it. Discovery walks `apps/*` and `packages/*`
rather than a hard-coded list, minus that one exclusion.

```bash
pnpm run release:version             # 0.1.0 today
pnpm run release:bump --patch       # 2.0.1 everywhere
pnpm run release:bump --minor       # 2.1.0
pnpm run release:bump --major       # 3.0.0
pnpm run release:bump --set 2.0.0   # explicit
```

- Exactly one of `--major`, `--minor`, `--patch`, `--set` is required; a
  malformed version, a no-op set or two selectors is a usage error (exit 2).
- A dirty working tree is refused (exit 1). `--allow-dirty` is for a dry run or
  a deliberate hand-off; the release check never takes it.
- `--dry-run` prints `would write <path>: <old> -> <new>` for every file and
  writes nothing. The tests assert byte equality afterwards.
- `bump` itself does not commit. The release flow commits the bump and the
  changelog together, so the tag points at one reviewable commit.

### Why not `ratchet release`

`ratchet release` computes a next version and writes a changelog from the
commits since the last tag, but it supports exactly one configured version file
and refuses to guess where a project keeps it (`the release is not configured`).
This repository needs seven manifests plus the `/healthz` literal to agree, and
`ratchet release` would also own `CHANGELOG.md` itself. Two writers for one
changelog is the defect, not the feature. The generator therefore lives in
`scripts/release.ts`; `ratchet` keeps its role as the gate and `ratchet verify`
is still run when a `verify` section exists in `ratchet.config.jsonc` (none
today, so the check skips it with no output).

## Changelog

```bash
pnpm run release:changelog --version 2.0.0 --date 2026-11-18 --dry-run
pnpm run release:changelog --version 2.0.0
```

Rules, in the order they apply:

1. **Range.** `--from <ref>` if given, else the last `v<number>` tag, else the
   first commit. Merge commits are excluded; their branch commits are the
   changes.
2. **Type to section.** Conventional types map to Keep a Changelog sections:
   `feat` → Added, `fix` → Fixed, `docs` → Documentation, `security` →
   Security, `deprecate` → Deprecated, `remove` → Removed; `perf`, `refactor`,
   `build`, `ci`, `chore`, `style`, `test` and an unprefixed subject → Changed.
   A `!` or a `BREAKING CHANGE:` body marks the entry `**Breaking:**`.
3. **Issue grouping.** `Refs #N`, `Closes #N` and `Fixes #N` bodies (and
   subject lines) are grouped per section: one bullet per issue, subjects
   joined with `; `. Additional refs stay visible as `(#12, #13)`. A bare
   `Issue #N` in prose is not a reference.
4. **Order.** Sections follow Keep a Changelog order, entries by issue number,
   unreferenced entries alphabetically.
5. **Date.** `--date`, else `SOURCE_DATE_EPOCH`, else the committer date of
   the newest commit (`%cs`, recorded in the commit). The runner's local
   timezone never enters the file, so the same history produces the same bytes
   on any machine.
6. **Placement.** The new `## [<version>] - <date>` section goes above the
   previous release. Re-running for the same version replaces that section; it
   never appends a duplicate.

An empty range prints `no commits since <ref>; nothing to write`, exits 0 and
touches no file. `--dry-run` prints the entire resulting `CHANGELOG.md`.

## Pre-release check

```bash
pnpm run release:check                    # gates:fast, then verify if configured
pnpm run release:check --with-e2e        # adds Playwright
```

Order:

1. **Dirty tree.** Fails before running anything; `gates:fast` is never started
   from an unreviewed tree.
2. **Version agreement.** `VERSION` is valid, every discovered manifest equals
   it, `SERVER_VERSION` equals it, and no lockfile importer disagrees.
3. **Changelog-vs-tag.** `CHANGELOG.md` must contain `## [<version>]`. `--tag`
   defaults to `v<version>`; when that tag exists it must name the same version
   and be an ancestor of `HEAD`. A missing tag is fine — this command runs
   before the tag is created.
4. **`pnpm run gates:fast`.**
5. **`ratchet verify`**, only when the ratchet config declares a `verify`
   section.
6. **`pnpm run test:e2e`**, only with `--with-e2e`.

`--skip-gates` and `--skip-verify` exist for tests and local iteration; the
release workflow never passes them. The check fails on a dirty tree, a
disagreeing package and a missing changelog section, which is the whole point.

## Release flow

Each step starts from the previous one green:

1. **Branch.** Cut `release/2.0.0` from `main`. Land the features first; the
   release branch only prepares metadata.
2. **Gates.** `pnpm run gates:fast` on the branch, plus `pnpm run test:e2e` when
   the change touches a surface it covers.
3. **Version.** `pnpm run release:bump --set 2.0.0`. From a 0.x version
   `--major` is not the 2.0 lever: it yields `1.0.0`, and the workflow rejects
   the tag. Review the nine-file diff.
4. **Changelog.** `pnpm run release:changelog --version 2.0.0 --dry-run`,
   then without `--dry-run`. Read the section; the generator groups, it does
   not write prose.
5. **Commit.** Commit the bump and the changelog together, with a message
   such as `chore(release): prepare 2.0.0`.
6. **Check.** `pnpm run release:check` on the clean branch; merge it to `main`
   with the gates green.
7. **Tag.** On the merge commit of `main`:
   `git tag -a v2.0.0 -m "OpenChat 2.0.0" && git push origin v2.0.0`. The tag
   name must be `v` plus the `VERSION` content; the workflow fails otherwise.
8. **Workflow.** `release.yml` re-runs `gates:fast`, builds `bff`,
   `code-host`, `artifact-host` and `tools` for `linux/amd64` and
   `linux/arm64` with buildx, pushes
   `ghcr.io/all-the-rest/openchat/<image>:2.0.0` and `:latest`, attaches SBOM
   and provenance, then creates the GitHub release from the changelog section.
   `tools` is the `openchat-tools` image `compose.yaml` runs for the agent tool
   runtime: it is published like the apps, so a pulled release has an image for
   every service compose builds here. The `opencode` and `dind` services keep
   pulling upstream images.
9. **Verify.** Pull the images on the host and run the deployment checklist in
   [`14-deployment.md`](14-deployment.md). The BFF's `/healthz` must report
   `2.0.0`; `deploy/swap.sh --expect-version 2.0.0` enforces it.

A rehearsal uses **Actions → Release → Run workflow** with `dry_run` left on:
the same gates and both architectures are built, nothing is pushed and no
release is created. On a non-tag ref the push and release conditions are false
by construction.

### Workflow guards

- Trigger: `push` of `v*` tags, plus `workflow_dispatch` with a boolean
  `dry_run` that defaults to `true`.
- Permissions: `contents: write` and `packages: write`, nothing else. The only
  credential is `GITHUB_TOKEN`; there is no repository secret in the file.
- `push` on the build action requires `github.ref_type == 'tag'`,
  `startsWith(github.ref, 'refs/tags/v')` and `inputs.dry_run != true`.
- The release job has the same tag guard and `gh release create --verify-tag`,
  so it cannot create a release for a tag that does not exist remotely.
- The version job rejects a tag name that does not equal `v$(cat VERSION)`.

### Using a released image

`compose.yaml` still names local images (`openchat-bff:${OPENCHAT_TAG:-local}`),
so the host pulls and retags, or uses its own compose override:

```bash
for image in bff code-host artifact-host tools; do
  docker pull "ghcr.io/all-the-rest/openchat/${image}:2.0.0"
  docker tag "ghcr.io/all-the-rest/openchat/${image}:2.0.0" "openchat-${image}:2.0.0"
done
OPENCHAT_TAG=2.0.0 deploy/swap.sh --release releases/2026-11-18 \
  --prepare pull --expect-version 2.0.0
```

Pin the version tag, never `latest`: `latest` exists for convenience and moves
on every release.

## Rollback

There are three layers; use the smallest one that fixes the problem.

1. **A bad container, same release.** `deploy/swap.sh` already restores
   `current` to `previous` and re-validates when `/healthz` or `/api/info`
   fails. No new image, no new tag.
2. **A bad release.** Re-point the host at the previous version tag
   (`OPENCHAT_TAG=1.9.0 deploy/swap.sh …`) after pulling it. Then fix forward
   with `2.0.1`; do not reuse `2.0.0` for different bytes.
3. **A bad tag or image.** Owner actions, in this order:
   - `gh release delete v2.0.0 --yes --cleanup-tag` (or delete the tag in the
     UI) and `git push origin :refs/tags/v2.0.0`.
   - Delete the three GHCR package versions for `2.0.0` (GitHub → Packages →
     the image → delete the version). Deleting the git tag alone leaves
     pullable images.
   - Re-point `latest` at the last good version, so a convenience pull cannot
     resurrect the bad build:
     `docker buildx imagetools create -t ghcr.io/all-the-rest/openchat/bff:latest ghcr.io/all-the-rest/openchat/bff:1.9.0`
     (repeat per image).
   - If the tag is protected, a maintainer with the bypass role performs the
     deletion; the workflow token cannot.
   - Write down why in the release issue. A missing image version is a
     supply-chain fact, not a cleanup detail.

## A major bump and the Code host

Two different majors are easy to confuse:

- **OpenChat's major** (`2.0.0`) versions this application. It may change the
  BFF API, cookies or the compose contract. `SERVER_VERSION` and the
  `/healthz` version follow it, so an old and a new BFF are distinguishable
  during a swap.
- **OpenCode's major** is pinned separately by
  `OPENCODE_CLIENT_RANGE` (`^2.3.0`) in `packages/opencode/src/index.ts`.
  `SUPPORTED_OPENCODE_MAJOR` is derived from that range, and the Code surface
  warns when the upstream host is on a different major. Bumping OpenChat does
  **not** change the supported OpenCode major; changing the client range is a
  dependency decision that runs the full gate suite and updates the warning
  contract.

The Code host consumes a ticket minted by the BFF, so a major BFF change that
alters the ticket payload or `CODE_HOST_ORIGIN` is a coordinated Code-host
change. During a major release, verify ticket → cookie → proxied API in the
frame before calling the cutover done. `deploy/swap.sh --expect-version` is the
cheap client/server skew check; the Code surface's major warning is the
upstream check.

## Owner steps still needed

These are repository or GitHub settings, not code in this slice:

1. **GHCR visibility.** After the first real publish, open the three packages
   under the organisation and pick visibility. Public images pull anonymously;
   private images need `docker login ghcr.io` on the host with a PAT carrying
   `read:packages`. Link each package to `all-the-rest/openchat` so the
   workflow's `GITHUB_TOKEN` can push subsequent versions.
2. **`main` protection.** Require the `fast`, `e2e` and `ratchet` checks, a pull
   request, and no force push. The release branch merges through the same gate;
   a tag is cut only from a green `main`.
3. **Tag protection.** A ruleset for `v*` that restricts creation, update and
   deletion to maintainers, blocks force updates, and allows the Release
   workflow to read the tag. Without it, anyone who can push branches can move
   a published release.
4. **Actions policy.** Keep the default `GITHUB_TOKEN` permission restricted;
   the workflow's own `permissions:` block grants exactly `contents: write`
   and `packages: write`. No environment, secret or PAT is required.
5. **Retention.** Decide how many image versions GHCR keeps and whether the
   previous minor stays pullable for rollback. Keep at least the last two
   releases.
6. **First dry run.** Actions → Release → Run workflow with `dry_run` on,
   against `main`, before cutting `v2.0.0`. It proves buildx, both
   architectures and the Dockerfiles on a clean runner without publishing.

## Tests

| File | Covers |
| --- | --- |
| `apps/server/test/release-version.test.ts` | bump table patch/minor/major; explicit set; missing manifest version inserted; all packages plus `SERVER_VERSION` plus lockfile importer agree; the artifact-tool manifest is in the plan; dirty-tree refusal and `--allow-dirty`; dry run writes nothing; usage errors; non-git refusal |
| `apps/server/test/release-changelog.test.ts` | grouping by type and issue; multiple refs; breaking marker; merge exclusion; prose is not a reference; section replacement; empty range writes nothing; history date and `SOURCE_DATE_EPOCH`; invalid date/version |
| `apps/server/test/release-check.test.ts` | clean pass; package disagreement; missing changelog section; dirty tree before gates; gate failure propagation; `ratchet verify` only when configured; `--with-e2e`; tag mismatch and matching tag |
| `apps/server/test/release-workflow.test.ts` | triggers; minimal permissions; only `GITHUB_TOKEN`; gates before build; three Dockerfiles; both architectures; SBOM/provenance; GHCR tags; every compose-built image in the matrix; non-tag guards; release notes extraction |

`node scripts/count-tests.ts` includes these and the ratchet floor stays a
floor: nothing was deleted.

## Manual acceptance (not run here)

1. `pnpm run release:bump --set 2.0.0 --dry-run` on a clean tree: nine
   `would write` lines, no diff.
2. `pnpm run release:changelog --version 2.0.0 --dry-run`: a section that
   groups by issue, with no merge commits.
3. Actions → Release → Run workflow (`dry_run: true`): four multi-arch builds
   succeed, nothing appears in GHCR.
4. On a scratch fork, push a `v2.0.0` tag: the release exists, its notes are
   the changelog section, and `docker manifest inspect` shows both platforms.
