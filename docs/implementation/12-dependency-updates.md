# 12 — Dependency updates: minor and patch automatic, major pinned

**Status:** 2026-11-18. Implements the update policy of issue #34, which
resolves the update-policy item of #20.

Spec: [`../spec/13-code-surface.md`](../spec/13-code-surface.md). Architecture:
[`../architecture/06-code-surface.md`](../architecture/06-code-surface.md)
and [`../architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md)
(owner-owned; not edited by this slice).

## Why the split

The BFF type-checks against `@opencode/client` and the Code surface probes the
Code host's upstream version. A bugfix or minor release is expected to keep the
response shapes compatible, and running it through the full CI proves that on
every PR. A major release is allowed to change shapes, so it needs a deliberate
spike, a range bump and a release note instead of an unattended merge.

The installed version never moves by "install time": the lockfile is the
authority, and CI installs with `pnpm install --frozen-lockfile`. A bump
therefore lands as a lockfile commit on `main`, not as drift on a deploy host.

## Policy

| Update | Example | Behaviour | Gate |
| --- | --- | --- | --- |
| Major | `2.x` → `3.x` | pinned; never auto-merged | spike of the affected endpoints, deliberate range and major bump, release note |
| Minor | `2.3` → `2.4` | one dependency PR, auto-merged | full CI: lint, typecheck, unit tests, build, e2e, ratchet |
| Patch | `2.3.0` → `2.3.1` | one dependency PR, auto-merged | the same full CI |

Two consequences make this safe:

1. **The suite tolerates a minor skew.** The compatibility check is about
   majors, so a `2.4.0` Code host next to the `2.3.0` client is healthy; the
   tests cover same-major, minor-skew and major-skew separately.
2. **The declared range satisfies the installed version.** A test reads
   `node_modules/@opencode/client/package.json` and checks the lockfile's
   version against `OPENCODE_CLIENT_RANGE`, so a stale lockfile fails locally
   and in CI.

## One source of truth

`packages/opencode/src/index.ts` exports:

| Export | Value | Meaning |
| --- | --- | --- |
| `OPENCODE_CLIENT_RANGE` | `"^2.3.0"` | The dependency range in `packages/opencode/package.json`: major pinned, minor open. |
| `SUPPORTED_OPENCODE_MAJOR` | `2` | Derived from the range; the only accepted host major. |
| `SUPPORTED_OPENCODE_MAJOR_LABEL` | `"2"` | The `expectedVersion` the API reports. |
| `matchesSupportedMajor(version)` | `boolean` | True for any `2.x.y`; false for `3.x.y`, another major, or a malformed version. |

`apps/server/src/code.ts` and `apps/server/src/routes.ts` consume the label and
the matcher. `packages/opencode/test/supported-major.test.ts` ties the exports
to the manifest and the installed package; there is no separate
`PINNED_OPENCODE_VERSION` anymore.

## What the warning means

`GET /api/info` reports `code.expectedVersion = "2"`.
`GET /api/code/status` reports the host's full `version`, the same
`expectedVersion`, and `matches: matchesSupportedMajor(version)`.

| Host version | Client | `matches` | UI |
| --- | --- | --- | --- |
| `2.4.0` | `2.3.0` | `true` | healthy; no warning |
| `2.3.1` | `2.3.0` | `true` | healthy; no warning |
| `3.0.0` | `2.3.0` | `false` | non-blocking warning: major skew; the frame still loads |
| unreachable | `2.3.0` | `false` | "Code host unreachable" panel, no warning line |

If the UI shows the warning, the deployed Code host runs another OpenCode
major than the BFF was built against. Deploy a matching host or run the major
upgrade below; the exchange itself is not blocked.

## How a bump reaches `main`

1. Renovate opens one grouped PR (for example `@opencode/client` to `2.4.1`)
   with the changed lockfile entry.
2. CI runs on the PR (`pull_request` in `.github/workflows/ci.yml`):
   `pnpm install --frozen-lockfile`, lint, typecheck, tests, build, e2e and
   ratchet.
3. When every required check is green, the platform merges the PR. Renovate
   does not push to `main` itself and does not bypass branch protection.
4. The lockfile commit on `main` is the release. A deploy rebuilds from that
   commit; nothing pulls `latest`.

No source change is expected for a minor or patch bump. If the PR needs one,
the release is no longer a routine update and gets reviewed like any change.

## `renovate.json`

The config lives at the repo root. It only enables the `npm` (which covers
pnpm) and `github-actions` managers, so container image and `latest`-tag
updates are out of scope.

| Rule | Scope | Result |
| --- | --- | --- |
| pnpm dependencies, minor + patch | all `npm` packages | one "pnpm dependencies" PR, `automerge` and `platformAutomerge` after CI |
| GitHub Actions, minor + patch | workflow actions | one "github-actions" PR, auto-merged after CI |
| `@opencode/client`, minor + patch | the client only | its own `@opencode/client` PR, auto-merged after CI |
| pnpm dependencies, major | all `npm` packages | one PR with the `major` label, no auto-merge |
| GitHub Actions, major | workflow actions | one PR with the `major` label, no auto-merge |
| `@opencode/client`, major | the client only | its own PR with the `major` label, no auto-merge |

`packages/opencode/test/renovate-config.test.ts` parses the file and asserts
the client minor/patch rule (auto-merge plus CI gate), the client major rule
(manual plus `major` label), the pnpm and Actions groups, and the absence of
`latest` and image managers. A broken config fails the suite instead of
landing silently.

### The config alone does nothing

Renovate has to be enabled on GitHub. The owner must:

1. Install and enable the Renovate app for the `all-the-rest/openchat`
   repository (or run a self-hosted instance against it).
2. Protect `main` and mark the CI jobs `fast`, `e2e` and `ratchet` as required
   status checks. `platformAutomerge` uses GitHub's auto-merge, which only
   completes when those checks pass; without branch protection the flag is
   inert.
3. Confirm the app has `contents: write` and `pull-requests: write`; the
   workflow's own `permissions: contents: read` stays unchanged.

Until those steps are done, updates arrive only when someone runs Renovate
manually, and nothing merges automatically.

## Major upgrade runbook

A major (`2.x` → `3.x`) is a planned change, not a dependency PR.

1. **Spike the affected endpoints.** Read the upstream release notes and check
   the endpoints the BFF uses: session list/create, messages, prompt, inbox and
   cancel, interrupt, models, agents, apps (MCP servers and skills), search,
   and the SSE event stream. Note shape, auth and event-name changes.
2. **Bump the range and the major together.** Change
   `packages/opencode/package.json`'s `"@opencode/client"` to `"^3.0.0"`
   (matching the spike) and `OPENCODE_CLIENT_RANGE` to the same string.
   `SUPPORTED_OPENCODE_MAJOR` and the label are derived, so they move with it;
   do not hard-code `3` elsewhere.
3. **Update the tests that name the major.** The server derives the label, but
   the web fixtures in `apps/web/test/code-page.test.tsx` and the sibling web
   suites hard-code `"2"` as `expectedVersion`, and
   `apps/server/test/code.test.ts` uses a `2.x.y` host for the healthy case.
   Move those fixtures to `"3"` / `3.x.y` and the major-skew case to `4.x.y`;
   `supported-major.test.ts` re-derives everything from the range.
4. **Run the gates.** `pnpm run gates:fast` must be 4/4, plus the e2e suite,
   before the PR is ready.
5. **Write the release note.** Name the old and new major, the spike's
   findings, any adapter changes and the required Code-host version.
6. **Deploy the BFF and the Code host together.** The Code host must run the
   new major; a mixed deployment sets the major-skew warning.

`apps/code-host` and its image base are not auto-updated by `renovate.json`;
the artifact host is deployed from a pinned image. Auto-adoption happens in the
repository, never as an unmanaged `latest` pull. Updating the OpenCode
**service** on the host remains a deployment runbook item (issue #9), not part
of this policy.

**Deployment requirement (owner-owned architecture):**
[`../architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md)
is owned by the owner. This document records the requirement instead of editing
it: the deployment pins the BFF image, the Code-host image and the OpenCode
service version at deploy time, and a major upgrade ships them as one unit.

## Tests

| File | Covers |
| --- | --- |
| `packages/opencode/test/supported-major.test.ts` | manifest range equals the export; the major is derived from the range; the installed client satisfies the range; same-major and minor skew pass; a major skew and malformed versions fail. |
| `packages/opencode/test/renovate-config.test.ts` | `renovate.json` parses; only npm and GitHub Actions managers; client minor/patch auto-merges after CI; client major stays manual with the `major` label; pnpm and Actions groups; no `latest` or image rules. |
| `apps/server/test/code.test.ts` | `/api/code/status` and `/api/info` report `"2"`; same major and minor skew match; a major skew does not; unreachable and malformed probes stay `matches: false`. |
| `apps/web/test/code-page.test.tsx` | the expected-major line on an unreachable host; a minor skew loads without a warning; a major skew warns without blocking the frame. |

No network is used: the probe is injected and the tests read local files only.
