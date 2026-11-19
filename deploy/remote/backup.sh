#!/usr/bin/env bash
#
# Backup and restore-check for the OpenChat stack (issue #9, milestone M7).
#
# One timestamped tar.gz outside the stack dir holds the state that matters,
# all of it read from fixed paths *inside* the stack dir:
#
#   .env                 host-only secrets, mode 0600
#   opencode-config/     seeded MCP config (opencode.json, mode 0600)
#   disks/workspace/     workspace + chat working files (chats/)
#   disks/artifacts/     artifact store
#   opencode-data/       export of the OpenCode data volume (see runbook)
#
# The archive also carries a readable manifest (target, source path, bytes,
# files) and SHA256SUMS for every archived file. A sidecar <archive>.sha256
# holds the checksum of the archive itself. Retention keeps the newest --keep
# archives (default 14) and deletes only files matching this script's own name.
#
# Safety: every target must exist, be readable and stay inside the stack dir.
# Symlinks in a target path or inside a target tree are rejected when they
# resolve outside the stack; tar never dereferences them. Nothing is printed
# from a secret file. --dry-run plans without writing; --restore-check extracts
# into a temp dir and verifies, never overwriting live data.

set -euo pipefail
export LC_ALL=C

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
BACKUP_DIR=/var/backups/openchat
KEEP=14
DRY_RUN=0
RESTORE_CHECK=0
ARCHIVE=""
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PREFIX=openchat-backup
TARGETS=(.env opencode-config disks/workspace disks/artifacts opencode-data)
SHASUM_TOOL=""

usage() {
  cat <<'EOF'
Back up the OpenChat stack into one timestamped archive.

Usage:
  backup.sh --backup-dir DIR [options]
  backup.sh --restore-check [--archive FILE] [options]

Options:
  --stack-dir DIR     stack root to read (default: /opt/stacks/openchat)
  --backup-dir DIR    where archives are written (default: /var/backups/openchat)
  --keep N            archives to retain, newest first (default: 14)
  --dry-run           print the plan; create, write and delete nothing
  --restore-check     extract the newest archive to a temp dir and verify it
  --archive FILE      archive to check (must be inside --backup-dir)
  --help

The archive contains .env, opencode-config, disks/workspace, disks/artifacts
and opencode-data plus manifest.txt and SHA256SUMS. Secrets are never printed.
EOF
}

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
plan() { printf 'would: %s\n' "$*"; }
require_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }

usage_error() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  printf 'Try %s --help\n' "$PROG" >&2
  exit 2
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --backup-dir) require_value "$@"; BACKUP_DIR=$2; shift 2 ;;
      --keep) require_value "$@"; KEEP=$2; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --restore-check) RESTORE_CHECK=1; shift ;;
      --archive) require_value "$@"; ARCHIVE=$2; shift 2 ;;
      --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done
  case "$KEEP" in
    ""|*[!0-9]*) usage_error "--keep must be a positive integer: $KEEP" ;;
  esac
  [ "$KEEP" -ge 1 ] || usage_error "--keep must be at least 1: $KEEP"
  validate_abs "--stack-dir" "$STACK_DIR"
  validate_abs "--backup-dir" "$BACKUP_DIR"
  [ "$RESTORE_CHECK" -eq 0 ] || [ "$DRY_RUN" -eq 0 ] || usage_error "--dry-run and --restore-check are mutually exclusive"
  [ -z "$ARCHIVE" ] || [ "$RESTORE_CHECK" -eq 1 ] || usage_error "--archive requires --restore-check"
}

validate_abs() {
  local name=$1 value=$2
  case "$value" in
    /*) ;;
    *) usage_error "$name must be an absolute path: $value" ;;
  esac
  case "$value" in
    *[[:cntrl:]]*) usage_error "$name must not contain control characters" ;;
  esac
  case "/$value/" in
    */../*) usage_error "$name must not contain a '..' segment: $value" ;;
  esac
}

is_under() {
  case "$1/" in "$2"/*) return 0 ;; esac
  return 1
}

# Reject a symlink anywhere in a target path, and every symlink inside a target
# tree that resolves outside the canonical stack dir. `cd -P` is read-only.
check_links() {
  local root=$1 rel=$2 p=$STACK_DIR link dest resolved dir
  local -a parts=()
  IFS=/ read -r -a parts <<<"$rel"
  for ((i = 0; i < ${#parts[@]} - 1; i++)); do
    p="$p/${parts[i]}"
    [ -L "$p" ] && die "symlink in target path refused: $p"
  done
  [ -L "$root" ] && die "symlink as backup target refused: $root"
  while IFS= read -r -d '' link; do
    dest=$(readlink "$link") || die "cannot read symlink: $link"
    case "$dest" in
      /*)
        dir=$(dirname "$dest")
        resolved="$(cd -P "$dir" 2>/dev/null && pwd -P)/$(basename "$dest")" ||
          die "symlink leaves the stack: $link -> $dest"
        ;;
      *)
        dir=${link%/*}
        resolved=$(cd "$dir" 2>/dev/null && cd "$dest" 2>/dev/null && pwd -P) ||
          die "symlink leaves the stack: $link -> $dest"
        ;;
    esac
    is_under "$resolved" "$STACK_DIR" || die "symlink leaves the stack: $link -> $dest"
  done < <(find "$root" -type l -print0 2>/dev/null)
}

validate_targets() {
  local rel abs
  for rel in "${TARGETS[@]}"; do
    abs="$STACK_DIR/$rel"
    [ -e "$abs" ] || die "missing backup target: $rel (under $STACK_DIR)"
    [ -r "$abs" ] || die "unreadable backup target: $rel"
    check_links "$abs" "$rel"
  done
}

tree_bytes() {
  local path=$1 total=0 f n
  if [ -f "$path" ]; then
    wc -c < "$path" | tr -d '[:space:]'
    return 0
  fi
  while IFS= read -r -d '' f; do
    n=$(wc -c < "$f") || die "cannot size $f"
    total=$((total + n))
  done < <(find "$path" -type f -print0 2>/dev/null)
  printf '%s' "$total"
}

file_count() {
  local path=$1 n=0
  if [ -f "$path" ]; then printf '1'; return 0; fi
  while IFS= read -r -d '' _; do n=$((n + 1)); done < <(find "$path" -type f -print0 2>/dev/null)
  printf '%s' "$n"
}

mode_of() {
  if [ -d "$1" ]; then printf 'dir'; return 0; fi
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || printf 'unknown'
}

pick_shasum() {
  if command -v sha256sum >/dev/null 2>&1; then SHASUM_TOOL=sha256sum
  elif command -v shasum >/dev/null 2>&1; then SHASUM_TOOL=shasum
  elif command -v openssl >/dev/null 2>&1; then SHASUM_TOOL=openssl
  else die "no SHA-256 tool found (sha256sum, shasum or openssl)"
  fi
}

sha256_file() {
  case "$SHASUM_TOOL" in
    sha256sum) sha256sum "$1" | awk '{ print $1 }' ;;
    shasum) shasum -a 256 "$1" | awk '{ print $1 }' ;;
    openssl) openssl dgst -sha256 "$1" | awk '{ print $NF }' ;;
  esac
}

write_manifest() {
  local staging=$1 rel abs
  {
    printf '# OpenChat backup manifest (format 1)\n'
    printf 'created_utc=%s\n' "$STAMP"
    printf 'source_stack=%s\n' "$STACK_DIR"
    printf 'archive_name=%s\n' "$ARCHIVE_NAME"
    printf 'target_count=%s\n' "${#TARGETS[@]}"
    printf '# TARGET <relative path> <bytes> <files> <mode>\n'
    for rel in "${TARGETS[@]}"; do
      abs="$STACK_DIR/$rel"
      printf 'TARGET %s %s %s %s\n' "$rel" "$(tree_bytes "$abs")" "$(file_count "$abs")" "$(mode_of "$abs")"
    done
  } > "$staging/manifest.txt"
}

write_checksums() {
  local staging=$1 rel f hash
  : > "$staging/SHA256SUMS"
  for rel in "${TARGETS[@]}"; do
    while IFS= read -r -d '' f; do
      hash=$(sha256_file "$f") || die "cannot checksum $f"
      printf '%s  %s\n' "$hash" "${f#"$STACK_DIR"/}" >> "$staging/SHA256SUMS"
    done < <(find "$STACK_DIR/$rel" -type f -print0 2>/dev/null)
  done
}

is_backup_name() {
  [[ $1 =~ ^openchat-backup-[0-9]{8}T[0-9]{6}Z-[0-9]+\.tar\.gz$ ]]
}

remove_file() {
  local file=$1 label=$2
  if [ "$DRY_RUN" -eq 1 ]; then
    plan rm "$file"
  elif rm -f "$file"; then
    note "removed $label: ${file##*/}"
  else
    printf '%s: could not remove %s\n' "$PROG" "$file" >&2
  fi
}

prune() {
  local -a archives=()
  local file side idx=0
  while IFS= read -r file; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    is_backup_name "${file##*/}" || continue
    archives+=("$file")
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PREFIX-*.tar.gz" -print 2>/dev/null | LC_ALL=C sort -r)
  if [ "${#archives[@]}" -gt 0 ]; then
    for file in "${archives[@]}"; do
      idx=$((idx + 1))
      [ "$idx" -gt "$KEEP" ] || continue
      remove_file "$file" "archive"
      side="$file.sha256"
      if [ -f "$side" ] && [ ! -L "$side" ]; then remove_file "$side" "checksum"; fi
    done
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    note "dry run: ${#archives[@]} archive(s) present, --keep $KEEP"
  else
    note "retention: ${#archives[@]} archive(s) present, --keep $KEEP"
  fi
}

create_archive() {
  [ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
  STACK_DIR=$(cd "$STACK_DIR" && pwd -P)
  is_under "$BACKUP_DIR" "$STACK_DIR" && die "--backup-dir must be outside the stack dir: $BACKUP_DIR"
  validate_targets
  pick_shasum
  ARCHIVE_NAME="$PREFIX-$STAMP-$$.tar.gz"
  local archive="$BACKUP_DIR/$ARCHIVE_NAME"
  local side="$archive.sha256"
  local staging

  if [ "$DRY_RUN" -eq 1 ]; then
    note "backup plan: stack=$STACK_DIR archive=$archive"
    for rel in "${TARGETS[@]}"; do
      note "  $rel: $(tree_bytes "$STACK_DIR/$rel") bytes, $(file_count "$STACK_DIR/$rel") files"
    done
    note "  manifest.txt and SHA256SUMS included; sidecar $side"
    prune
    note "dry run: nothing was read into an archive, written or deleted"
    return 0
  fi

  if [ ! -d "$BACKUP_DIR" ]; then
    mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
  fi
  [ -d "$BACKUP_DIR" ] || die "cannot create backup directory: $BACKUP_DIR"
  staging=$(mktemp -d "${TMPDIR:-/tmp}/openchat-backup.XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  write_manifest "$staging"
  write_checksums "$staging"

  tar -czf "$archive" -C "$staging" manifest.txt SHA256SUMS \
    -C "$STACK_DIR" "${TARGETS[@]}" || die "tar failed; remove $archive and retry"
  printf '%s  %s\n' "$(sha256_file "$archive")" "$ARCHIVE_NAME" > "$side"
  note "backup: wrote $archive ($(tree_bytes "$archive") bytes)"
  note "backup: sidecar $side, manifest + SHA256SUMS inside the archive"
  prune
  trap - EXIT
}

newest_archive() {
  local file found=""
  while IFS= read -r file; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    is_backup_name "${file##*/}" || continue
    found=$file
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PREFIX-*.tar.gz" -print 2>/dev/null | LC_ALL=C sort)
  printf '%s' "$found"
}

verify_extracted() {
  local dir=$1 rel abs bytes files mode expected_bytes expected_files expected_mode
  local hash line got
  [ -f "$dir/manifest.txt" ] || die "archive has no manifest.txt"
  [ -f "$dir/SHA256SUMS" ] || die "archive has no SHA256SUMS"
  local count=0
  while read -r tag rel bytes files mode; do
    [ "$tag" = "TARGET" ] || continue
    count=$((count + 1))
    abs="$dir/$rel"
    [ -e "$abs" ] || die "restore-check: missing archived target $rel"
    expected_bytes=$(tree_bytes "$abs")
    expected_files=$(file_count "$abs")
    [ "$expected_bytes" = "$bytes" ] || die "restore-check: byte mismatch for $rel ($expected_bytes != $bytes)"
    [ "$expected_files" = "$files" ] || die "restore-check: file count mismatch for $rel ($expected_files != $files)"
    expected_mode=$(mode_of "$abs")
    [ "$expected_mode" = "$mode" ] || die "restore-check: mode mismatch for $rel ($expected_mode != $mode)"
  done < "$dir/manifest.txt"
  [ "$count" -eq "${#TARGETS[@]}" ] || die "restore-check: manifest lists $count targets, expected ${#TARGETS[@]}"

  count=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    hash=${line%%  *}
    rel=${line#*  }
    [ "$hash" != "$line" ] || die "restore-check: malformed SHA256SUMS line"
    [ -f "$dir/$rel" ] || die "restore-check: checksum names a missing file: $rel"
    got=$(sha256_file "$dir/$rel") || die "restore-check: cannot checksum $rel"
    [ "$got" = "$hash" ] || die "restore-check: checksum mismatch for $rel"
    count=$((count + 1))
  done < "$dir/SHA256SUMS"
  [ "$count" -gt 0 ] || die "restore-check: SHA256SUMS is empty"
  note "restore-check: ok ($count files verified, ${#TARGETS[@]} targets, mode and bytes match)"
}

restore_check() {
  local archive side tmp entry
  if [ -n "$ARCHIVE" ]; then
    archive=$ARCHIVE
  else
    archive=$(newest_archive)
  fi
  [ -n "$archive" ] && [ -f "$archive" ] && [ ! -L "$archive" ] || die "no archive found in $BACKUP_DIR"
  is_under "$archive" "$BACKUP_DIR" || die "--archive must be inside --backup-dir: $archive"
  side="$archive.sha256"
  [ -f "$side" ] && [ ! -L "$side" ] || die "missing checksum sidecar: $side"
  pick_shasum
  local expected actual
  expected=$(awk 'NR==1 { print $1 }' "$side")
  actual=$(sha256_file "$archive")
  [ "$expected" = "$actual" ] || die "restore-check: archive checksum mismatch (sidecar vs archive)"

  while IFS= read -r entry; do
    case "$entry" in
      ..|/*|*../*|*/..) die "restore-check: unsafe path in archive: $entry" ;;
    esac
  done < <(tar -tzf "$archive" 2>/dev/null)

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/openchat-restore.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  (umask 077; tar -xzf "$archive" -C "$tmp") || die "restore-check: extraction failed"
  note "restore-check: archive $archive"
  verify_extracted "$tmp"
  note "restore-check: live stack at $STACK_DIR was not touched"
  trap - EXIT
}

main() {
  parse_args "$@"
  if [ "$RESTORE_CHECK" -eq 1 ]; then
    [ -d "$BACKUP_DIR" ] || die "backup directory not found: $BACKUP_DIR"
    restore_check
  else
    create_archive
  fi
}

main "$@"
