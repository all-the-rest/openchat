# ADR 0009 — OpenCode Update Policy

**Status:** accepted for 2.5 (2026-11-19)
**Deciders:** owner, orchestrator

## Context

OpenChat is a clean-room UI over a self-hosted OpenCode host. The server image
and the `@opencode/client` range are pinned (`deploy/Dockerfile.opencode`,
`compose.yaml`, `packages/opencode/src/index.ts`), but nothing states how a new
OpenCode version reaches the host. The predecessor auto-updated in place with a
watcher; doing that here would move the host underneath a pinned client and
silent the mismatch warning that the Code surface shows on a major skew. A
documented policy is needed so a builder or operator does not "fix" a version
warning by pulling the latest image, and so an upgrade has a reversible path.

The research baseline is `docs/research/opencode-web-gate-parity.md` (gap 5).
`docs/implementation/21-opencode-upgrade.md` records the pin table, the exact
upgrade commands and the rollback; `docs/architecture/03-auth-deployment.md`
states the backup-before-upgrade and version-agreement rules. This decision
names the policy those pages implement; it does not duplicate their runbooks.

## Decision

1. **No auto-update.** Nothing pulls a new OpenCode on its own. The derived
   image is pinned by tag *and* index digest, and `deploy.sh` builds from the
   checked-out tree. No watcher is deployed; a locally tagged `openchat-*:<sha>`
   image is not a watcher target. Rebuilds are deploy-driven, so a rebuild
   without a version bump only picks up base-package patches.
2. **Upgrade on demand, on a minor.** A patch or minor is adopted when there is
   a reason (fix, feature, security note), not on a calendar. A **major** bump
   is a code change first: `SUPPORTED_OPENCODE_MAJOR` and the `@opencode/client`
   range move together with it, followed by a new build and smoke check.
3. **Digest pin, tag for humans.** The Dockerfile carries both the version tag
   and the immutable index digest. Bumping resolves a new digest rather than
   hand-editing a number in two places; the previous digest is retained for
   rollback.
4. **Verify before the swap.** The candidate tree passes `pnpm run gates:fast`,
   the upstream changelog is read for breaking API changes, and one local smoke
   builds the image and reports its version. On the host, `/api/info` must
   report the expected version and the ticket exchange must still work before
   `current` moves.
5. **Rollback via `previous`.** The swap keeps a `previous` link; a failed
   upgrade restores it and re-verifies. The state machine is exercised locally
   by `deploy/remote/test/upgrade.test.sh` with fake docker and fake curl.
6. **Mismatch is a warning, not a migration.** `/api/code/status` reports
   `version`, `expectedVersion` and `matches`; the Code surface warns when
   `matches` is false but keeps the frame. A patch-level skew between deploys is
   expected and must not trigger an automatic pull or an automatic migration.

## Consequences

- An operator upgrades deliberately with the runbook in
  `docs/implementation/21-opencode-upgrade.md` and
  `docs/implementation/28-operations.md`; there is no background update job to
  monitor.
- A version mismatch in the UI means someone moved the host without moving the
  supported label — it is a signal to run the upgrade path, not a bug to hide.
- The end-to-end rehearsal (pull a second version next to the running one,
  verify, roll back, verify) is **not** part of this decision: it needs a live
  VPS and an owner-scheduled window. It remains the live-host-gated acceptance
  item of issue #38. The local half — upgrade, version check, rollback via
  `previous` — is already proven by `deploy/remote/test/upgrade.test.sh`.

## References

- `docs/implementation/21-opencode-upgrade.md` — pin table, evidence, commands,
  rollback, rehearsal status.
- `docs/implementation/28-operations.md` — upgrade/rollback runbook and the
  tested state machine.
- `docs/architecture/03-auth-deployment.md` — backup-before-upgrade and
  version-agreement rules.
- `docs/research/opencode-web-gate-parity.md` — parity gap 5.
