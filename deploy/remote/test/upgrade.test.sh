#!/usr/bin/env bash
#
# The local half of the upgrade/rollback sequence (docs/implementation/
# 28-operations.md, "Upgrade test"). Against a temporary stack, a fake docker
# and a fake curl, it exercises the real deploy/swap.sh: release A -> release B
# -> rollback to A, and a candidate whose version does not match
# --expect-version, which must leave `current` on the release that ran before.
#
# deploy.sh itself needs SSH, so its --dry-run output is the only part checked
# here; the live run is marked owner-run in the runbook.

set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ok() { printf 'ok - %s\n' "$*"; }

DOCKER_LOG=""

build_swap_fixture() {
  local root=$1 bin
  bin="$root/bin"
  DOCKER_LOG="$root/docker.log"
  mkdir -p "$bin" "$root/stack/releases/a" "$root/stack/releases/b" "$root/stack/releases/c"
  printf 'BACKEND_MODE=live\nSESSION_SECRET=fixture\n' > "$root/stack/.env"
  chmod 600 "$root/stack/.env"
  for release in a b c; do
    printf 'services: {}\n' > "$root/stack/releases/$release/compose.yaml"
    printf '%s\n' "$release" > "$root/stack/releases/$release/tag"
  done
  : > "$DOCKER_LOG"
  stub_bin "$bin" docker '
printf "%s\n" "$*" >> "$DOCKER_LOG"
exit 0'
  stub_bin "$bin" curl '
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --write-out|--max-time) shift 2 ;;
    --silent|--show-error|--fail) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */healthz) body=${FAKE_HEALTHZ:-"{\"ok\":true,\"mode\":\"live\",\"version\":\"2.2.0\"}"} ;;
  *) body=${FAKE_API_INFO:-"{\"reachable\":true}"} ;;
esac
[ -n "$out" ] && printf "%s" "$body" > "$out"
printf "%s" "${FAKE_CODE:-200}"'
}

swap_in() {
  local root=$1
  shift
  env PATH="$root/bin:$PATH" DOCKER_LOG="$DOCKER_LOG" FAKE_HEALTHZ="${FAKE_HEALTHZ:-}" \
    bash "$SWAP" --stack-dir "$root/stack" --release "$root/stack/$1" --timeout 5 "${@:2}"
}

test_upgrade_and_rollback() {
  local root; root=$(new_dir)
  build_swap_fixture "$root"

  run_capture swap_in "$root" releases/a
  [ "$RUN_STATUS" -eq 0 ] || fail "first swap exited $RUN_STATUS: $OUTPUT"
  assert_eq "$(readlink "$root/stack/current")" "releases/a" "current after A"
  assert_missing "$root/stack/previous"

  run_capture swap_in "$root" releases/b
  [ "$RUN_STATUS" -eq 0 ] || fail "upgrade to B exited $RUN_STATUS: $OUTPUT"
  assert_eq "$(readlink "$root/stack/current")" "releases/b" "current after B"
  assert_eq "$(readlink "$root/stack/previous")" "releases/a" "previous after B"

  run_capture swap_in "$root" releases/a
  [ "$RUN_STATUS" -eq 0 ] || fail "rollback to A exited $RUN_STATUS: $OUTPUT"
  assert_eq "$(readlink "$root/stack/current")" "releases/a" "current after rollback"
  assert_eq "$(readlink "$root/stack/previous")" "releases/b" "previous after rollback"
  ok "upgrade A -> B -> rollback to A moves current and previous as documented"
}

test_version_mismatch_rolls_back() {
  local root ups; root=$(new_dir)
  build_swap_fixture "$root"
  run_capture swap_in "$root" releases/a
  [ "$RUN_STATUS" -eq 0 ] || fail "first swap exited $RUN_STATUS: $OUTPUT"

  run_capture env PATH="$root/bin:$PATH" DOCKER_LOG="$DOCKER_LOG" FAKE_HEALTHZ="" \
    bash "$SWAP" --stack-dir "$root/stack" --release "$root/stack/releases/b" \
    --timeout 5 --expect-version 9.9.9
  [ "$RUN_STATUS" -eq 1 ] || fail "version mismatch exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "does not report version 9.9.9" "swap output"
  assert_eq "$(readlink "$root/stack/current")" "releases/a" "current after failed upgrade"
  ups=$(grep -c 'compose .* up -d --wait' "$DOCKER_LOG" || true)
  [ "${ups:-0}" -ge 2 ] || fail "expected a candidate start and a rollback start, saw $ups"
  ok "--expect-version refuses a skewed candidate and restores the previous release"
}

# Issue #43 / M3: a rollback to a release that predates the migration binds the
# named volume, which keeps only the pre-migration snapshot. The rollback still
# happens, but it must say loudly that post-migration sessions are not in it.
test_rollback_to_a_volume_release_warns() {
  local root; root=$(new_dir)
  build_swap_fixture "$root"
  printf 'services:\n  opencode:\n    volumes:\n      - type: bind\n        source: /opt/stacks/openchat/disks/opencode-data\n        target: /root/.local/share/opencode\n' \
    > "$root/stack/releases/b/compose.yaml"

  run_capture swap_in "$root" releases/a
  [ "$RUN_STATUS" -eq 0 ] || fail "first swap exited $RUN_STATUS: $OUTPUT"

  mkdir -p "$root/stack/disks/opencode-data"
  printf 'volume=openchat_opencode-data\nfiles=1\n' \
    > "$root/stack/disks/opencode-data/.openchat-migrated"
  printf 'opencode-data\n' > "$root/stack/disks/opencode-data/.openchat-disk"

  run_capture swap_in "$root" releases/b --expect-version 9.9.9
  [ "$RUN_STATUS" -eq 1 ] || fail "the skewed candidate exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "session data written after the migration is NOT in that copy" "rollback warning"
  assert_contains "$OUTPUT" "releases/a does not bind disks/opencode-data" "rollback warning"
  assert_eq "$(readlink "$root/stack/current")" "releases/a" "current after the rollback"
  ok "a rollback to a volume-bound release warns about the pre-migration snapshot"
}

test_deploy_dry_run_names_the_upgrade() {
  local root; root=$(new_dir)
  build_swap_fixture "$root"
  run_capture env PATH="$root/bin:$PATH" bash "$DEPLOY" --dry-run \
    --tag 20261118T120000Z --expect-version 2.2.0
  [ "$RUN_STATUS" -eq 0 ] || fail "deploy --dry-run exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "would: ssh --" "deploy dry run"
  assert_contains "$OUTPUT" "would: 'rsync'" "deploy dry run"
  assert_contains "$OUTPUT" "'--expect-version' '2.2.0'" "deploy dry run"
  assert_contains "$OUTPUT" "dry run: nothing was synced, built, started, mounted or reloaded" "deploy dry run"
  ok "deploy.sh --dry-run plans the tag and version check without touching a host"
}

test_upgrade_and_rollback
test_version_mismatch_rolls_back
test_rollback_to_a_volume_release_warns
test_deploy_dry_run_names_the_upgrade
