#!/usr/bin/env bash
#
# Behaviour of deploy/remote/backup.sh against a temporary stack:
# dry-run writes nothing, the archive holds the five sources, checksums are
# verified (and a mismatch is caught), retention keeps N and only deletes its
# own files, symlinks are not followed out of the stack, secrets stay out of
# every output, and restore-check leaves live data alone.

set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ok() { printf 'ok - %s\n' "$*"; }

test_dry_run_writes_nothing() {
  local root; root=$(new_dir)
  make_stack "$root"
  run_capture backup_in "$root" --dry-run
  [ "$RUN_STATUS" -eq 0 ] || fail "dry run exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "would: write $root/out/openchat-backup-" "dry run"
  assert_contains "$OUTPUT" "would: include workspace" "dry run"
  assert_contains "$OUTPUT" "would: include memory" "dry run"
  assert_missing "$root/out"
  ok "dry run prints the plan and creates nothing"
}

test_archive_contents_and_manifest() {
  local root archive listing before after; root=$(new_dir)
  make_stack "$root"
  run_capture backup_in "$root" --stamp 20261118T120000Z
  [ "$RUN_STATUS" -eq 0 ] || fail "backup exited $RUN_STATUS: $OUTPUT"
  archive="$root/out/openchat-backup-20261118T120000Z.tar.gz"
  assert_file "$archive"
  assert_file "$archive.sha256"
  assert_file "$archive.manifest.txt"
  assert_eq "$(sha256_of "$archive")" "$(awk '{ print $1 }' "$archive.sha256")" "archive digest"

  listing=$(tar -tzf "$archive")
  for entry in manifest.txt checksums.sha256 .env opencode-config/opencode.json \
      opencode-data/sessions/s1.json artifacts/doc.md workspace/chats/message.txt \
      memory/facts.jsonl; do
    assert_contains "$listing" "$entry" "archive listing"
  done

  # .env keeps mode 0600 inside the archive; the archive and sidecars are 0600.
  tar -tvzf "$archive" | grep -Eq '^-rw------- .* \.env$' ||
    fail ".env is not 0600 inside the archive"
  for path in "$archive" "$archive.sha256" "$archive.manifest.txt"; do
    [ "$(file_mode "$path")" = "600" ] || fail "$path is not 0600"
  done

  # The manifest names source, bytes and count per entry, but no secret value.
  local manifest; manifest=$(cat "$root/out/openchat-backup-20261118T120000Z.tar.gz.manifest.txt")
  assert_contains "$manifest" "kind" "manifest"
  assert_contains "$manifest" "workspace" "manifest"
  local stack_real; stack_real=$(cd "$root/stack" && pwd -P)
  assert_contains "$manifest" "$stack_real/.env (mode 600)" "manifest"
  assert_contains "$manifest" "opencode-data" "manifest"
  assert_contains "$manifest" "memory" "manifest"
  assert_not_contains "$manifest" "SENTINEL_SECRET_VALUE" "manifest"
  assert_not_contains "$OUTPUT" "SENTINEL_SECRET_VALUE" "backup output"

  before=$(cd "$root/stack" && find . -type f -exec cksum {} + | LC_ALL=C sort)
  run_capture bash "$BACKUP" --stack-dir "$root/stack" --out-dir "$root/out" --restore-check
  [ "$RUN_STATUS" -eq 0 ] || fail "restore-check exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "archive digest matches" "restore-check"
  assert_contains "$OUTPUT" "file(s) verified" "restore-check"
  assert_contains "$OUTPUT" "live data was not touched" "restore-check"
  assert_not_contains "$OUTPUT" "SENTINEL_SECRET_VALUE" "restore-check output"
  after=$(cd "$root/stack" && find . -type f -exec cksum {} + | LC_ALL=C sort)
  assert_eq "$after" "$before" "stack tree after restore-check"
  ok "archive holds the six sources, 0600 .env, a readable manifest; restore-check verifies it untouched"
}

test_checksum_mismatch_is_detected() {
  local root archive tampered stage name; root=$(new_dir)
  make_stack "$root"
  run_capture backup_in "$root" --stamp 20261118T120000Z
  archive="$root/out/openchat-backup-20261118T120000Z.tar.gz"
  stage="$root/stage"
  mkdir -p "$stage"
  tar -xzf "$archive" -C "$stage"

  # Replace the first payload digest with a bogus 64-zero digest and repack.
  awk 'NR == 1 { print "0000000000000000000000000000000000000000000000000000000000000000  .env"; next } { print }' \
    "$stage/checksums.sha256" > "$stage/checksums.tmp"
  mv "$stage/checksums.tmp" "$stage/checksums.sha256"
  name=openchat-backup-20261118T120001Z.tar.gz
  tar -czf "$root/out/$name" -C "$stage" .env opencode-config opencode-data artifacts workspace manifest.txt checksums.sha256

  run_capture bash "$BACKUP" --stack-dir "$root/stack" --out-dir "$root/out" \
    --archive "$root/out/$name" --restore-check
  [ "$RUN_STATUS" -ne 0 ] || fail "restore-check accepted a wrong checksum: $OUTPUT"
  assert_contains "$OUTPUT" "checksum verification failed" "restore-check"
  ok "a wrong payload checksum fails restore-check"
}

test_retention_keeps_n_and_spares_foreign_files() {
  local root count names decoy; root=$(new_dir)
  make_stack "$root"
  for stamp in 20261118T120001Z 20261118T120002Z 20261118T120003Z; do
    run_capture backup_in "$root" --stamp "$stamp" --keep 2
    [ "$RUN_STATUS" -eq 0 ] || fail "backup at $stamp exited $RUN_STATUS: $OUTPUT"
  done
  decoy="$root/out/openchat-backup-latest.tar.gz"
  printf 'not mine\n' > "$decoy"
  printf 'also not mine\n' > "$root/out/notes.txt"

  run_capture backup_in "$root" --stamp 20261118T120004Z --keep 2
  [ "$RUN_STATUS" -eq 0 ] || fail "retention run exited $RUN_STATUS: $OUTPUT"
  names=$(for path in "$root/out"/openchat-backup-*.tar.gz; do
    [ -f "$path" ] && printf '%s\n' "${path##*/}"
  done | grep -E '^openchat-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz$' | LC_ALL=C sort)
  count=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
  assert_eq "$count" "2" "archives kept"
  assert_contains "$names" "20261118T120004Z" "kept archives"
  assert_contains "$names" "20261118T120003Z" "kept archives"
  assert_file "$decoy"
  assert_file "$root/out/notes.txt"
  assert_missing "$root/out/openchat-backup-20261118T120002Z.tar.gz"
  assert_missing "$root/out/openchat-backup-20261118T120002Z.tar.gz.sha256"
  ok "retention keeps 2, removes older sidecars and spares foreign files"
}

test_refuses_missing_or_symlinked_source() {
  local root outside; root=$(new_dir)
  make_stack "$root"
  rm -rf "$root/stack/disks/artifacts"
  run_capture backup_in "$root"
  [ "$RUN_STATUS" -ne 0 ] || fail "backup without an artifact store succeeded"
  assert_contains "$OUTPUT" "missing artifact store" "backup failure"
  assert_missing "$root/out"

  make_stack "$root/no-memory"
  rm -rf "$root/no-memory/stack/disks/memory"
  run_capture backup_in "$root/no-memory"
  [ "$RUN_STATUS" -ne 0 ] || fail "backup without a memory store succeeded"
  assert_contains "$OUTPUT" "missing memory store" "backup failure"
  assert_missing "$root/no-memory/out"

  make_stack "$root/repair"
  outside=$(new_dir)
  mkdir -p "$outside/artifacts"
  printf 'outside\n' > "$outside/artifacts/leak.md"
  rm -rf "$root/repair/stack/disks/artifacts"
  ln -s "$outside/artifacts" "$root/repair/stack/disks/artifacts"
  run_capture backup_in "$root/repair"
  [ "$RUN_STATUS" -ne 0 ] || fail "backup followed a symlinked source"
  assert_contains "$OUTPUT" "refusing to follow it" "symlink refusal"
  assert_missing "$root/repair/out"
  ok "a missing or symlinked source is refused before anything is written"
}

test_inner_symlink_is_archived_not_followed() {
  local root archive listing; root=$(new_dir)
  make_stack "$root"
  mkdir -p "$root/outside"
  printf 'do not leak\n' > "$root/outside/secret.txt"
  ln -s "$root/outside" "$root/stack/disks/workspace/export"
  run_capture backup_in "$root" --stamp 20261118T120000Z
  [ "$RUN_STATUS" -eq 0 ] || fail "backup with an inner symlink exited $RUN_STATUS: $OUTPUT"
  archive="$root/out/openchat-backup-20261118T120000Z.tar.gz"
  listing=$(tar -tzf "$archive")
  assert_contains "$listing" "workspace/export" "archive listing"
  assert_not_contains "$listing" "workspace/export/secret.txt" "archive listing"
  assert_not_contains "$(cat "$archive.manifest.txt")" "do not leak" "manifest"
  ok "an inner symlink stays a link; nothing outside the stack is read"
}

test_out_dir_inside_stack_is_refused() {
  local root; root=$(new_dir)
  make_stack "$root"
  run_capture bash "$BACKUP" --stack-dir "$root/stack" --out-dir "$root/stack/backups" \
    --opencode-data "$root/data/opencode-data"
  [ "$RUN_STATUS" -eq 2 ] || fail "an --out-dir inside the stack exited $RUN_STATUS"
  assert_contains "$OUTPUT" "must be outside the stack" "usage error"
  assert_missing "$root/stack/backups"
  ok "an archive destination inside the stack is a usage error"
}

# Issue #43: after the migration the live state is the loopback disk; the named
# volume is only the rollback copy and must not be the backup source. An
# unmounted image refuses instead of archiving an empty directory.
test_backs_up_the_migrated_opencode_disk() {
  local root listing manifest stack_real; root=$(new_dir)
  make_stack "$root"
  stack_real=$(cd "$root/stack" && pwd -P)
  mkdir -p "$root/stack/disks/opencode-data"
  printf 'opencode-data\n' > "$root/stack/disks/opencode-data/.openchat-disk"
  printf '{"session":2}\n' > "$root/stack/disks/opencode-data/migrated.json"
  : > "$root/stack/disks/opencode-data.img"

  run_capture bash "$BACKUP" --stack-dir "$root/stack" --out-dir "$root/out" \
    --stamp 20261118T130000Z
  [ "$RUN_STATUS" -eq 0 ] || fail "a backup from the disk exited $RUN_STATUS: $OUTPUT"
  listing=$(tar -tzf "$root/out/openchat-backup-20261118T130000Z.tar.gz")
  assert_contains "$listing" "opencode-data/migrated.json" "archive listing"
  assert_not_contains "$listing" "opencode-data/sessions/s1.json" "archive listing"
  manifest=$(cat "$root/out/openchat-backup-20261118T130000Z.tar.gz.manifest.txt")
  assert_contains "$manifest" "$stack_real/disks/opencode-data" "manifest"
  assert_not_contains "$manifest" "sessions" "manifest"

  rm -f "$root/stack/disks/opencode-data/.openchat-disk"
  run_capture bash "$BACKUP" --stack-dir "$root/stack" --out-dir "$root/out2" \
    --stamp 20261118T130001Z
  [ "$RUN_STATUS" -ne 0 ] || fail "a backup from an unmounted disk succeeded: $OUTPUT"
  assert_contains "$OUTPUT" "not mounted" "unmounted disk refusal"
  assert_missing "$root/out2"
  ok "the migrated disk is the backup source; an unmounted image is refused"
}

file_mode() {
  if stat -c %a "$1" >/dev/null 2>&1; then
    stat -c %a "$1"
  else
    stat -f %Lp "$1"
  fi
}

test_dry_run_writes_nothing
test_archive_contents_and_manifest
test_checksum_mismatch_is_detected
test_retention_keeps_n_and_spares_foreign_files
test_refuses_missing_or_symlinked_source
test_inner_symlink_is_archived_not_followed
test_out_dir_inside_stack_is_refused
test_backs_up_the_migrated_opencode_disk
