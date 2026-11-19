#!/usr/bin/env bash
#
# The OpenCode state-disk precondition of deploy/swap.sh (issue #43, finding 1).
#
# The remote overlay binds `disks/opencode-data` over OpenCode's state. Until
# `migrate-opencode-data.sh --apply` copied the named volume onto that disk, the
# volume is the only copy: a start on the empty disk makes the disk non-empty, the
# migration then refuses and recovering without a rollback is gone.
#
# Against a temporary stack, a fake docker and a fake curl this proves: a volume
# with files and an unstamped disk is refused with the exact migration command
# and no swap; an empty (never-used) volume is allowed; a volume that is gone is
# allowed; a volume with files on a stamped disk is allowed; and a release that
# still uses the named volume is not blocked.

set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VOLUME_NAME=openchat_opencode-data
STAMP=.openchat-migrated

ok() { printf 'ok - %s\n' "$*"; }

# The state disk bind as `docker compose config --no-interpolate` renders it in a
# release file: the source path is what identifies the bind.
build_fixture() {
  local root=$1 bin
  bin=$root/bin
  mkdir -p "$bin" "$root/stack/releases/a" "$root/stack/releases/b" \
    "$root/stack/disks/opencode-data" "$root/volume"
  printf 'BACKEND_MODE=live\nSESSION_SECRET=fixture\n' > "$root/stack/.env"
  chmod 600 "$root/stack/.env"
  printf 'services: {}\n' > "$root/stack/releases/a/compose.yaml"
  cat > "$root/stack/releases/b/compose.yaml" <<'YAML'
services:
  opencode:
    volumes:
      - type: bind
        source: /opt/stacks/openchat/disks/opencode-data
        target: /root/.local/share/opencode
YAML
  printf '{"session":1}\n' > "$root/volume/s1.json"
  : > "$root/docker.log"
  ln -sfn releases/a "$root/stack/current"

  stub_bin "$bin" docker '
log=$FAKE_LOG
printf "docker %s\n" "$*" >> "$log"
case "${1:-}" in
  volume)
    last=
    for arg in "$@"; do last=$arg; done
    [ "$last" = "$FAKE_VOLUME" ] || exit 1
    printf "%s\n" "$last"
    exit 0
    ;;
  run)
    find "$FAKE_VOLUME_DIR" -type f | wc -l | tr -d " "
    exit 0
    ;;
esac
exit 0
'
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
  */healthz) body="{\"ok\":true,\"mode\":\"live\",\"version\":\"2.2.0\"}" ;;
  *) body="{\"reachable\":true}" ;;
esac
[ -n "$out" ] && printf "%s" "$body" > "$out"
printf "%s" "200"'
}

# swap to release B (the one that binds the disk). FAKE_VOLUME_DIR and
# FAKE_VOLUME select the volume the fake daemon reports.
swap_to_b() {
  local root=$1
  shift
  env PATH="$root/bin:$PATH" \
    FAKE_LOG="$root/docker.log" \
    FAKE_VOLUME="${FAKE_VOLUME:-$VOLUME_NAME}" \
    FAKE_VOLUME_DIR="${FAKE_VOLUME_DIR:-$root/volume}" \
    bash "$SWAP" --stack-dir "$root/stack" --release "$root/stack/releases/b" \
    --timeout 5 "$@"
}

stack_real() { (cd "$1/stack" && pwd -P); }
up_calls() { grep -c 'compose .* up -d' "$1/docker.log" 2>/dev/null || true; }

test_refuses_a_volume_with_data_on_an_unstamped_disk() {
  local root real; root=$(new_dir)
  build_fixture "$root"
  real=$(stack_real "$root")

  run_capture swap_to_b "$root"
  [ "$RUN_STATUS" -eq 1 ] || fail "the swap exited $RUN_STATUS, want 1: $OUTPUT"
  assert_contains "$OUTPUT" "deploy/remote/migrate-opencode-data.sh --stack-dir $real --apply" "refusal"
  assert_contains "$OUTPUT" "refusing to start OpenCode on an empty state disk" "refusal"
  assert_contains "$OUTPUT" "Nothing was changed" "refusal"
  assert_eq "$(readlink "$root/stack/current")" "releases/a" "current after the refusal"
  assert_missing "$root/stack/previous"
  assert_eq "$(up_calls "$root")" "0" "stack starts after the refusal"
  assert_not_contains "$(cat "$root/docker.log")" "compose --project-name openchat" "docker calls"
  ok "a volume with data and an unstamped disk is refused, names the migration and starts nothing"
}

test_allows_an_empty_never_used_volume() {
  local root empty; root=$(new_dir)
  build_fixture "$root"
  empty=$(new_dir)

  export FAKE_VOLUME_DIR=$empty
  run_capture swap_to_b "$root"
  unset FAKE_VOLUME_DIR
  [ "$RUN_STATUS" -eq 0 ] || fail "an empty volume exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "is empty and $STAMP is absent" "empty volume"
  assert_eq "$(readlink "$root/stack/current")" "releases/b" "current after the swap"
  assert_eq "$(up_calls "$root")" "1" "stack starts with an empty volume"
  ok "a volume created but never written to does not block the swap"
}

test_allows_a_missing_volume() {
  local root; root=$(new_dir)
  build_fixture "$root"

  export FAKE_VOLUME=absent_volume
  run_capture swap_to_b "$root"
  unset FAKE_VOLUME
  [ "$RUN_STATUS" -eq 0 ] || fail "a missing volume exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "does not exist; a fresh host" "missing volume"
  assert_eq "$(readlink "$root/stack/current")" "releases/b" "current after the swap"
  ok "a fresh host without the named volume is allowed"
}

test_allows_a_stamped_disk() {
  local root; root=$(new_dir)
  build_fixture "$root"
  printf 'volume=%s\nfiles=1\n' "$VOLUME_NAME" \
    > "$root/stack/disks/opencode-data/$STAMP"

  run_capture swap_to_b "$root"
  [ "$RUN_STATUS" -eq 0 ] || fail "a stamped disk exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "state disk: migrated ($STAMP present)" "stamped disk"
  assert_eq "$(readlink "$root/stack/current")" "releases/b" "current after the swap"
  assert_eq "$(up_calls "$root")" "1" "stack starts on the stamped disk"
  ok "a volume with data on a stamped disk is allowed: the disk is the live copy"
}

test_release_using_the_volume_is_not_blocked() {
  local root; root=$(new_dir)
  build_fixture "$root"

  run_capture env PATH="$root/bin:$PATH" FAKE_LOG="$root/docker.log" \
    FAKE_VOLUME="$VOLUME_NAME" FAKE_VOLUME_DIR="$root/volume" \
    bash "$SWAP" --stack-dir "$root/stack" --release "$root/stack/releases/a" --timeout 5
  # `current` already points at A, so the run validates and changes nothing.
  [ "$RUN_STATUS" -eq 0 ] || fail "a release on the volume exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "does not bind disks/opencode-data; nothing to check" "volume release"
  ok "a release that still starts on the named volume is not blocked by the preflight"
}

test_dry_run_plans_the_check() {
  local root; root=$(new_dir)
  build_fixture "$root"

  run_capture swap_to_b "$root" --dry-run
  [ "$RUN_STATUS" -eq 0 ] || fail "the dry run exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "would: refuse if volume $VOLUME_NAME holds files" "dry run"
  assert_eq "$(readlink "$root/stack/current")" "releases/a" "current after the dry run"
  ok "a dry run plans the precondition without reading the volume"
}

test_refuses_a_volume_with_data_on_an_unstamped_disk
test_allows_an_empty_never_used_volume
test_allows_a_missing_volume
test_allows_a_stamped_disk
test_release_using_the_volume_is_not_blocked
test_dry_run_plans_the_check
