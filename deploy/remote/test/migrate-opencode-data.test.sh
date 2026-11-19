#!/usr/bin/env bash
#
# Behaviour of deploy/remote/migrate-opencode-data.sh against a temporary stack
# (issue #43, finding 7). No docker, no root and no mounted image: a fake
# `docker` on PATH emulates the volume, the copy and `compose stop`, and fake
# `mount`/`umount`/`mountpoint`/`mkfs.ext4`/`truncate` keep the host untouched.
#
# Proven here: the dry run is the default and writes nothing, `--apply` copies
# exactly once (a second run refuses), an empty disk created by mount-disks.sh
# is adopted instead of refused, a disk with foreign data is refused before the
# service stops, `--rollback` renames the image and keeps it, and no file name or
# file content from the volume reaches any output.

set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MIGRATE="$REPO_ROOT/deploy/remote/migrate-opencode-data.sh"
VOLUME_NAME=openchat_opencode-data
SENTINEL_VALUE=SENTINEL43TOKEN
SENTINEL_NAME=credentials-prod-42.json

ok() { printf 'ok - %s\n' "$*"; }

# macOS /var is a symlink to /private/var; the script resolves its --stack-dir,
# so compare against the physical path.
new_root() {
  local dir
  dir=$(new_dir)
  (cd "$dir" && pwd -P)
}

# A fake daemon: identifies the volume, answers `compose stop`, and emulates the
# copy container by copying the fixture volume into the destination bind. A run
# without a `:/dst` bind is the read-only probe and prints counts only.
install_shims() {
  local root=$1 bin="$1/bin"
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
  compose)
    printf "compose stopped\n"
    exit 0
    ;;
  run)
    src=; dst=; prev=
    for arg in "$@"; do
      if [ "$prev" = "-v" ]; then
        case "$arg" in
          *:/src:ro) src=${arg%:/src:ro} ;;
          *:/dst) dst=${arg%:/dst} ;;
        esac
      fi
      prev=$arg
    done
    [ -n "$src" ] || exit 1
    [ "$src" = "$FAKE_VOLUME" ] && src=$FAKE_VOLUME_DIR
    if [ -z "$dst" ]; then
      printf "%s %s\n" "$(find "$src" -type f | wc -l | tr -d " ")" "$(du -sk "$src" | cut -f1)"
      exit 0
    fi
    [ -n "${FAKE_COPY_FAIL:-}" ] && exit 1
    mkdir -p "$dst"
    cp -a "$src/." "$dst/" || exit 1
    find "$src" -type f | wc -l | tr -d " "
    exit 0
    ;;
esac
exit 0
'
  stub_bin "$bin" mount '
printf "mount %s\n" "$*" >> "$FAKE_LOG"
[ -n "${FAKE_MOUNT_FAIL:-}" ] && exit 1
target=
for arg in "$@"; do target=$arg; done
mkdir -p "$target"
: > "$FAKE_MOUNT_STATE/$(basename "$target")"
'
  stub_bin "$bin" umount '
printf "umount %s\n" "$*" >> "$FAKE_LOG"
target=
for arg in "$@"; do target=$arg; done
rm -f "$FAKE_MOUNT_STATE/$(basename "$target")"
'
  stub_bin "$bin" mountpoint '
dir=
for arg in "$@"; do dir=$arg; done
[ -f "$FAKE_MOUNT_STATE/$(basename "$dir")" ]
'
  stub_bin "$bin" mkfs.ext4 '
printf "mkfs %s\n" "$*" >> "$FAKE_LOG"
exit 0
'
  stub_bin "$bin" truncate '
printf "truncate %s\n" "$*" >> "$FAKE_LOG"
path=
for arg in "$@"; do path=$arg; done
[ -f "$path" ] || : > "$path"
'
}

# The stack a migrated host has: .env, one rendered release, the disks directory,
# and a volume fixture with one innocuous file and one that must never be named.
make_migration_stack() {
  local root=$1
  mkdir -p "$root/stack/disks" "$root/stack/current" \
    "$root/volume/sessions" "$root/bin" "$root/log" "$root/state"
  printf 'SESSION_SECRET=SENTINEL_SECRET_VALUE\n' > "$root/stack/.env"
  printf 'services: {}\n' > "$root/stack/current/compose.yaml"
  printf '{"session":1}\n' > "$root/volume/sessions/s1.json"
  printf 'token=%s\n' "$SENTINEL_VALUE" > "$root/volume/$SENTINEL_NAME"
  : > "$root/log/docker.log"
  install_shims "$root"
}

migrate() {
  local root=$1
  shift
  PATH="$root/bin:$PATH" \
    FAKE_LOG="$root/log/docker.log" \
    FAKE_MOUNT_STATE="$root/state" \
    FAKE_VOLUME="$VOLUME_NAME" \
    FAKE_VOLUME_DIR="$root/volume" \
    bash "$MIGRATE" --stack-dir "$root/stack" "$@"
}

mount_calls() { grep -c "^mount " "$1/log/docker.log" 2>/dev/null || true; }
copy_calls() { grep -c ":/dst" "$1/log/docker.log" 2>/dev/null || true; }

test_help_and_usage_errors() {
  local root; root=$(new_root)
  make_migration_stack "$root"

  run_capture migrate "$root" --help
  [ "$RUN_STATUS" -eq 0 ] || fail "--help exited $RUN_STATUS"
  assert_contains "$OUTPUT" "--rollback" "--help"
  assert_contains "$OUTPUT" "The default is a dry run" "--help"

  for value in 0 abc 512M; do
    run_capture migrate "$root" --image-mib "$value" --apply
    [ "$RUN_STATUS" -eq 2 ] || fail "--image-mib $value exited $RUN_STATUS, want 2"
    assert_contains "$OUTPUT" "--image-mib" "usage error"
  done

  run_capture migrate "$root" --frobnicate
  [ "$RUN_STATUS" -eq 2 ] || fail "an unknown flag exited $RUN_STATUS, want 2"
  ok "--help, a bad --image-mib and an unknown flag are handled"
}

test_dry_run_writes_nothing() {
  local root; root=$(new_root)
  make_migration_stack "$root"

  run_capture migrate "$root"
  [ "$RUN_STATUS" -eq 0 ] || fail "dry run exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "stopping only the opencode service" "dry run"
  assert_contains "$OUTPUT" "would: docker compose --project-name openchat" "dry run"
  assert_contains "$OUTPUT" "would: docker run --rm -v openchat_opencode-data:/src:ro" "dry run"
  assert_contains "$OUTPUT" "volume: $VOLUME_NAME (2 files" "dry run"
  assert_missing "$root/stack/disks/opencode-data.img"
  assert_missing "$root/stack/disks/opencode-data"
  assert_eq "$(copy_calls "$root")" "0" "copy containers in the dry run"
  assert_not_contains "$(cat "$root/log/docker.log")" "compose stopped" "dry run log"

  # --apply --dry-run is the same plan, not an action.
  run_capture migrate "$root" --apply --dry-run
  [ "$RUN_STATUS" -eq 0 ] || fail "--apply --dry-run exited $RUN_STATUS: $OUTPUT"
  assert_missing "$root/stack/disks/opencode-data.img"
  ok "the dry run is the default, prints the plan and creates nothing"
}

test_apply_copies_once_and_refuses_a_second_run() {
  local root; root=$(new_root)
  make_migration_stack "$root"
  local mnt="$root/stack/disks/opencode-data"

  run_capture migrate "$root" --apply
  [ "$RUN_STATUS" -eq 0 ] || fail "--apply exited $RUN_STATUS: $OUTPUT"
  assert_file "$root/stack/disks/opencode-data.img"
  assert_file "$mnt/sessions/s1.json"
  assert_file "$mnt/.openchat-migrated"
  assert_contains "$OUTPUT" "stopping only the opencode service" "apply"
  assert_contains "$OUTPUT" "copy: 2 file(s)" "apply"
  assert_contains "$OUTPUT" "detached $mnt" "apply"
  assert_contains "$OUTPUT" "--rollback" "rollback hint"
  assert_contains "$(cat "$root/log/docker.log")" "compose --project-name openchat" "compose stop"
  assert_contains "$(cat "$root/log/docker.log")" "stop opencode" "compose stop"
  assert_contains "$(cat "$mnt/.openchat-migrated")" "volume=$VOLUME_NAME" "stamp"
  assert_eq "$(copy_calls "$root")" "1" "copy containers after the first apply"

  run_capture migrate "$root" --apply
  [ "$RUN_STATUS" -ne 0 ] || fail "a second --apply succeeded: $OUTPUT"
  assert_contains "$OUTPUT" "already migrated" "second apply"
  assert_eq "$(copy_calls "$root")" "1" "copy containers after the second apply"
  assert_eq "$(mount_calls "$root")" "2" "mount calls (the second run only mounts to inspect)"
  ok "one apply copies once; the second apply refuses before touching the volume"
}

test_adopts_the_empty_disk_mount_disks_created() {
  local root; root=$(new_root)
  make_migration_stack "$root"
  local mnt="$root/stack/disks/opencode-data"
  mkdir -p "$mnt"
  : > "$root/stack/disks/opencode-data.img"
  printf 'opencode-data\n' > "$mnt/.openchat-disk"

  run_capture migrate "$root" --apply
  [ "$RUN_STATUS" -eq 0 ] || fail "apply on an empty disk exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "adopting it" "adopt"
  assert_file "$mnt/sessions/s1.json"
  assert_not_contains "$(cat "$root/log/docker.log")" "mkfs " "adopted disk is not re-created"
  ok "a fresh disk created by mount-disks.sh is adopted, not refused"
}

test_refuses_a_disk_with_foreign_data() {
  local root; root=$(new_root)
  make_migration_stack "$root"
  local mnt="$root/stack/disks/opencode-data"
  mkdir -p "$mnt"
  : > "$root/stack/disks/opencode-data.img"
  printf '{"unknown":true}\n' > "$mnt/leftover.json"

  run_capture migrate "$root" --apply
  [ "$RUN_STATUS" -ne 0 ] || fail "apply on a non-empty unknown disk succeeded: $OUTPUT"
  assert_contains "$OUTPUT" "refusing to copy" "foreign data refusal"
  assert_contains "$OUTPUT" "--rollback" "foreign data refusal"
  assert_not_contains "$(cat "$root/log/docker.log")" "compose stopped" "no service stopped"
  assert_eq "$(copy_calls "$root")" "0" "copy containers after the refusal"
  assert_file "$mnt/leftover.json"
  ok "a disk with data and no migration stamp is refused before the service stops"
}

test_copy_failure_keeps_the_image_and_the_volume() {
  local root; root=$(new_root)
  make_migration_stack "$root"

  export FAKE_COPY_FAIL=1
  run_capture migrate "$root" --apply
  unset FAKE_COPY_FAIL
  [ "$RUN_STATUS" -ne 0 ] || fail "a failed copy exited 0: $OUTPUT"
  assert_contains "$OUTPUT" "copy failed" "copy failure"
  assert_contains "$OUTPUT" "volume $VOLUME_NAME untouched" "copy failure"
  assert_file "$root/stack/disks/opencode-data.img"
  assert_file "$root/volume/sessions/s1.json"
  assert_missing "$root/stack/disks/opencode-data/.openchat-migrated"
  ok "a failed copy keeps the image, leaves the volume alone and prints no file name"
}

test_rollback_moves_the_image_and_keeps_it() {
  local root; root=$(new_root)
  make_migration_stack "$root"
  local mnt="$root/stack/disks/opencode-data"
  local img="$root/stack/disks/opencode-data.img"

  run_capture migrate "$root" --apply
  [ "$RUN_STATUS" -eq 0 ] || fail "--apply exited $RUN_STATUS: $OUTPUT"

  run_capture migrate "$root" --rollback
  [ "$RUN_STATUS" -eq 0 ] || fail "--rollback exited $RUN_STATUS: $OUTPUT"
  assert_missing "$img"
  local moved
  moved=$(find "$root/stack/disks" -maxdepth 1 -name 'opencode-data.img.rollback-*' | head -n 1)
  [ -n "$moved" ] || fail "rollback did not keep the image under a .rollback- name"
  assert_contains "$OUTPUT" "$moved" "rollback output"
  assert_contains "$OUTPUT" "kept; nothing was deleted" "rollback output"
  assert_contains "$OUTPUT" "up -d opencode" "rollback output"
  assert_contains "$OUTPUT" "openchat_opencode-data" "rollback output"
  # The volume is the rollback path and is never modified.
  assert_file "$root/volume/$SENTINEL_NAME"

  run_capture migrate "$root" --rollback
  [ "$RUN_STATUS" -eq 0 ] || fail "a second rollback exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "nothing to move" "second rollback"
  ok "rollback detaches and renames the image, keeps the data and prints the way back"
}

test_output_never_carries_a_name_or_a_value() {
  local root; root=$(new_root)
  make_migration_stack "$root"
  local all stamp

  run_capture migrate "$root" --apply
  [ "$RUN_STATUS" -eq 0 ] || fail "--apply exited $RUN_STATUS: $OUTPUT"
  all=$OUTPUT
  stamp=$(cat "$root/stack/disks/opencode-data/.openchat-migrated")
  run_capture migrate "$root" --rollback
  [ "$RUN_STATUS" -eq 0 ] || fail "--rollback exited $RUN_STATUS"
  all="$all
$OUTPUT"
  for text in "$SENTINEL_VALUE" "$SENTINEL_NAME" "s1.json" "sessions/"; do
    assert_not_contains "$all" "$text" "script output"
    assert_not_contains "$stamp" "$text" "migration stamp"
  done
  assert_contains "$all" "2 file(s)" "output keeps counts"
  ok "no file name and no file content from the volume reaches any output"
}

test_capacity_refusal_names_the_flag() {
  local root; root=$(new_root)
  make_migration_stack "$root"

  run_capture migrate "$root" --apply --image-mib 1
  [ "$RUN_STATUS" -ne 0 ] || fail "a too-small image succeeded: $OUTPUT"
  assert_contains "$OUTPUT" "--image-mib 1" "capacity refusal"
  assert_missing "$root/stack/disks/opencode-data.img"
  assert_not_contains "$(cat "$root/log/docker.log")" "compose stopped" "no service stopped"
  ok "an image smaller than the volume is refused before anything starts"
}

test_help_and_usage_errors
test_dry_run_writes_nothing
test_apply_copies_once_and_refuses_a_second_run
test_adopts_the_empty_disk_mount_disks_created
test_refuses_a_disk_with_foreign_data
test_copy_failure_keeps_the_image_and_the_volume
test_rollback_moves_the_image_and_keeps_it
test_output_never_carries_a_name_or_a_value
test_capacity_refusal_names_the_flag
