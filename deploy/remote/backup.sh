#!/usr/bin/env bash
#
# Backup and restore-check for the OpenChat stack (issue #9, M7), run as root on
# the host. One timestamped archive outside the stack holds the six sources a
# restore needs: .env (0600), opencode-config/, opencode-data, artifacts,
# workspace (with chats/) and memory. Inside: manifest.txt and checksums.sha256;
# beside it: <name>.sha256 and <name>.manifest.txt.
#
# Safety: a missing, unreadable or symlinked source stops the run before
# anything is written; inner symlinks are archived as links; retention touches
# only this script's names and sidecars; no .env value is read or printed;
# --dry-run writes nothing; --restore-check extracts into a temp dir and leaves
# live data alone. Live files that change mid-tar fail the run instead of leaving
# an archive whose checksums cannot hold.
#
# Usage: backup.sh [options] | backup.sh --restore-check [--archive FILE]
# Exit codes: 0 success, 1 backup or verification failure, 2 usage error.

set -euo pipefail

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
OUT_DIR=/var/backups/openchat
PROJECT=openchat
VOLUME_NAME=opencode-data
VOLUME_DIR=""
KEEP=14
DRY_RUN=0
RESTORE_CHECK=0
ARCHIVE_ARG=""
STAMP=""
PREFIX=openchat-backup
NAME_RE='^openchat-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz$'
HASH_CMD=()
STAT_CMD=()

usage() {
  cat <<'EOF'
Back up the OpenChat stack state, or verify the newest archive.
Usage:
  backup.sh [options]
  backup.sh --restore-check [--archive FILE]
  backup.sh --dry-run
Options:
  --stack-dir DIR     stack root (default: /opt/stacks/openchat)
  --out-dir DIR       archive destination outside the stack (default: /var/backups/openchat)
  --project NAME      compose project name (default: openchat)
  --opencode-data DIR OpenCode data directory (default: the mounted
                      disks/opencode-data once stamped; else the volume on a
                      host without the image; an unstamped image is refused)
  --keep N            archives to keep, newest first (default: 14)
  --stamp TS          archive stamp, YYYYMMDDTHHMMSSZ (default: now)
  --restore-check     verify the newest archive in a temp dir; live data untouched
  --archive FILE      archive for --restore-check (default: newest)
  --dry-run           print every step ('would: …'); write nothing
  --help

The manifest lists paths, bytes and counts, never a value from .env.
EOF
}

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
usage_error() { printf '%s: %s\n' "$PROG" "$*" >&2; printf 'Try %s --help\n' "$PROG" >&2; exit 2; }
note() { printf '%s\n' "$*"; }
warn() { printf '%s: %s\n' "$PROG" "$*" >&2; }
plan() { printf 'would: %s\n' "$*"; }
require_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }
require_absolute() {
  case "$2" in
    /*) ;;
    *) usage_error "$1 must be an absolute path: $2" ;;
  esac
  case "/$2/" in
    */../*) usage_error "$1 must not contain a '..' segment: $2" ;;
  esac
  case "$2" in
    *[[:cntrl:]]*) usage_error "$1 must not contain control characters" ;;
  esac
}
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --out-dir) require_value "$@"; OUT_DIR=$2; shift 2 ;;
      --project) require_value "$@"; PROJECT=$2; shift 2 ;;
      --opencode-data) require_value "$@"; VOLUME_DIR=$2; shift 2 ;;
      --keep) require_value "$@"; KEEP=$2; shift 2 ;;
      --stamp) require_value "$@"; STAMP=$2; shift 2 ;;
      --archive) require_value "$@"; ARCHIVE_ARG=$2; shift 2 ;;
      --restore-check) RESTORE_CHECK=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) case "$1" in
           *=*) usage_error "KEY=VALUE arguments are refused; secrets live in the host .env" ;;
         esac
         usage_error "unknown argument: $1" ;;
    esac
  done
  require_absolute --stack-dir "$STACK_DIR"
  require_absolute --out-dir "$OUT_DIR"
  case "$KEEP" in
    ""|*[!0-9]*) usage_error "--keep must be a positive integer: $KEEP" ;;
  esac
  [ "$KEEP" -ge 1 ] || usage_error "--keep must be at least 1: $KEEP"
  [ -z "$STAMP" ] || printf '%s\n' "$STAMP" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$' ||
    usage_error "--stamp must look like YYYYMMDDTHHMMSSZ: $STAMP"
  if [ -n "$ARCHIVE_ARG" ]; then
    [ "$RESTORE_CHECK" -eq 1 ] || usage_error "--archive only applies to --restore-check"
    require_absolute --archive "$ARCHIVE_ARG"; fi
  [ "$RESTORE_CHECK" -eq 0 ] || [ "$DRY_RUN" -eq 0 ] ||
    usage_error "--dry-run and --restore-check are separate runs"
  [ -z "$VOLUME_DIR" ] || require_absolute --opencode-data "$VOLUME_DIR"
}
detect_tools() {
  HASH_CMD=(sha256sum)
  command -v sha256sum >/dev/null 2>&1 || HASH_CMD=(shasum -a 256)
  command -v "${HASH_CMD[0]}" >/dev/null 2>&1 || die "sha256sum or shasum is required"
  STAT_CMD=(stat -c %s)
  stat -c %s /dev/null >/dev/null 2>&1 || STAT_CMD=(stat -f %z)
}
file_bytes() { "${STAT_CMD[@]}" "$1"; }
tree_bytes() {
  find "$1" -type f -exec "${STAT_CMD[@]}" {} + 2>/dev/null |
    awk '{ total += $1 } END { print total + 0 }'
}
tree_files() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
file_mode() {
  if stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else stat -f %Lp "$1"; fi
}
# kind is "file" or "dir"; a symlink source is refused, never followed.
require_source() {
  local path=$1 label=$2 kind=$3
  [ -e "$path" ] || die "missing $label: $path"
  [ -L "$path" ] && die "$label is a symlink; refusing to follow it: $path"
  if [ "$kind" = file ]; then
    { [ -f "$path" ] && [ -r "$path" ]; } || die "$label is not a readable file: $path"
  else
    [ -d "$path" ] || die "$label is not a directory: $path"
    { [ -r "$path" ] && [ -x "$path" ]; } || die "$label is not readable: $path (run as root on the host)"
  fi
}
resolve_stack() {
  [ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
  STACK_DIR=$(cd "$STACK_DIR" && pwd -P)
}

# The volume lives under /var/lib/docker/volumes/<project>_<name>/_data.
# Issue #43: the stamp lives INSIDE the image, so an unmounted image hides it;
# falling through to the volume would archive the pre-migration copy without a
# warning. Only a host with no image at all (pre-migration) reads the volume; a
# stamped disk is the live copy, and an image without a visible stamp is a
# refusal, never a silent volume archive.
resolve_volume() {
  local mountpoint stamp="$STACK_DIR/disks/opencode-data/.openchat-migrated"
  if [ -n "$VOLUME_DIR" ]; then VOLUME_SOURCE=${VOLUME_DIR%/}; return 0; fi
  if [ -f "$stamp" ]; then
    VOLUME_SOURCE=$STACK_DIR/disks/opencode-data
    [ -f "$VOLUME_SOURCE/.openchat-disk" ] ||
      die "the opencode-data disk is migrated but not mounted; run deploy/remote/mount-disks.sh"
    return 0
  fi
  if [ -f "$STACK_DIR/disks/opencode-data.img" ]; then
    die "the opencode-data image exists ($STACK_DIR/disks/opencode-data.img) but is not mounted or not migrated yet, so $stamp is invisible. The named volume may be the pre-migration copy, so no archive was written. Repair the mount with 'systemctl start openchat-disks.service' (or deploy/remote/mount-disks.sh), then run deploy/remote/migrate-opencode-data.sh --stack-dir $STACK_DIR --apply if the migration has not run"
  fi
  if [ "$DRY_RUN" -eq 1 ] && ! command -v docker >/dev/null 2>&1; then
    VOLUME_SOURCE="<docker volume ${PROJECT}_${VOLUME_NAME}>"; VOLUME_UNRESOLVED=1; return 0
  fi
  command -v docker >/dev/null 2>&1 ||
    die "docker is required to locate ${PROJECT}_${VOLUME_NAME}; pass --opencode-data DIR"
  mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' \
    "${PROJECT}_${VOLUME_NAME}" 2>/dev/null || true)
  [ -n "$mountpoint" ] ||
    die "cannot resolve docker volume ${PROJECT}_${VOLUME_NAME}; the state disk carries no .openchat-migrated, so the volume is still the live copy. Run deploy/remote/migrate-opencode-data.sh --apply, or pass --opencode-data DIR"
  VOLUME_SOURCE=${mountpoint%/}
}

canonical_path() {
  local path=$1 parent=${1%/*}
  if [ -d "$path" ]; then ( cd "$path" && pwd -P ); return 0; fi
  [ -n "$parent" ] || parent=/
  [ -n "${path##*/}" ] || path=$path/.
  printf '%s/%s\n' "$(canonical_path "$parent")" "${path##*/}"
}

check_out_dir() {
  local out_real stack_real
  out_real=$(canonical_path "$OUT_DIR")
  stack_real=$(canonical_path "$STACK_DIR")
  [ "$out_real" != "$stack_real" ] ||
    usage_error "--out-dir must be outside the stack: $OUT_DIR"
  case "$out_real/" in
    "$stack_real"/*) usage_error "--out-dir must be outside the stack: $OUT_DIR" ;;
  esac
}

archive_names() {
  local path name
  [ -d "$OUT_DIR" ] || return 0
  for path in "$OUT_DIR"/*; do
    [ -f "$path" ] || continue
    name=${path##*/}
    printf '%s\n' "$name" | grep -Eq "$NAME_RE" || continue
    printf '%s\n' "$name"
  done | LC_ALL=C sort
}

write_sidecars() {
  local archive=$1 digest
  digest=$("${HASH_CMD[@]}" "$archive" | awk '{ print $1 }')
  printf '%s  %s\n' "$digest" "${archive##*/}" > "$archive.sha256"
  chmod 600 "$archive.sha256"
  cp "$MANIFEST_TMP" "$archive.manifest.txt"
  chmod 600 "$archive.manifest.txt"
}

prune_archives() {
  local names count excess removed=0 name
  names=$(archive_names)
  [ -n "$names" ] || { note "retention: no archives in $OUT_DIR yet"; return 0; }
  count=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
  [ "$count" -gt "$KEEP" ] || { note "retention: $count archive(s), nothing to remove (keep $KEEP)"; return 0; }
  excess=$((count - KEEP))
  [ "$DRY_RUN" -eq 0 ] || { plan "keep the newest $KEEP archive(s), remove $excess older matching $PREFIX-*"; return 0; }
  for name in $names; do
    [ "$removed" -lt "$excess" ] || break
    printf '%s\n' "$name" | grep -Eq "$NAME_RE" || continue
    rm -f -- "$OUT_DIR/$name" "$OUT_DIR/$name.sha256" "$OUT_DIR/$name.manifest.txt"
    removed=$((removed + 1))
  done
  note "retention: removed $removed archive(s), kept the newest $KEEP"
}

# A backup that fills the disk is an outage: refuse below payload + 5%.
require_space() {
  local need_kb probe avail_kb
  need_kb=$(($1 / 1024 + $1 / 20480 + 1))
  probe=$OUT_DIR
  while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
  avail_kb=$(df -P -k "$probe" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$avail_kb" in ""|*[!0-9]*) die "cannot read free space for $probe" ;; esac
  [ "$avail_kb" -ge "$need_kb" ] ||
    die "not enough free space in $probe: ${avail_kb} KiB available, ${need_kb} KiB needed (retention keeps older archives too)"
  note "space: ${avail_kb} KiB free in $probe, archive needs about ${need_kb} KiB"
}

# The volume is copied into the staging tree (it is small); the disk images are
# streamed from their mount points so the workspace is read once.
create_backup() {
  local stamp archive_name archive_path tmp_archive stage checksum_lines mode
  local env_bytes config_bytes config_files volume_bytes volume_files
  local artifacts_bytes artifacts_files workspace_bytes workspace_files total
  local memory_bytes memory_files

  resolve_stack
  check_out_dir
  require_source "$STACK_DIR/.env" "host-only .env" file
  mode=$(file_mode "$STACK_DIR/.env")
  [ "$mode" = 600 ] || warn ".env mode is $mode, expected 600"
  require_source "$STACK_DIR/opencode-config" "seeded OpenCode config" dir
  require_source "$STACK_DIR/disks/artifacts" "artifact store" dir
  require_source "$STACK_DIR/disks/workspace" "workspace and chat files" dir
  require_source "$STACK_DIR/disks/memory" "memory store" dir
  resolve_volume
  [ "${VOLUME_UNRESOLVED:-0}" -ne 0 ] || require_source "$VOLUME_SOURCE" "OpenCode data volume" dir

  env_bytes=$(file_bytes "$STACK_DIR/.env")
  config_bytes=$(tree_bytes "$STACK_DIR/opencode-config")
  config_files=$(tree_files "$STACK_DIR/opencode-config")
  artifacts_bytes=$(tree_bytes "$STACK_DIR/disks/artifacts")
  artifacts_files=$(tree_files "$STACK_DIR/disks/artifacts")
  workspace_bytes=$(tree_bytes "$STACK_DIR/disks/workspace")
  workspace_files=$(tree_files "$STACK_DIR/disks/workspace")
  memory_bytes=$(tree_bytes "$STACK_DIR/disks/memory")
  memory_files=$(tree_files "$STACK_DIR/disks/memory")
  if [ "${VOLUME_UNRESOLVED:-0}" -eq 0 ]; then
    volume_bytes=$(tree_bytes "$VOLUME_SOURCE")
    volume_files=$(tree_files "$VOLUME_SOURCE")
  else
    volume_bytes=0
    volume_files=0
  fi
  total=$((env_bytes + config_bytes + volume_bytes + artifacts_bytes + workspace_bytes + memory_bytes))

  stamp=${STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  archive_name="$PREFIX-$stamp.tar.gz"
  archive_path="$OUT_DIR/$archive_name"

  if [ "$DRY_RUN" -eq 1 ]; then
    plan "create $OUT_DIR (mode 0700)"
    plan "write $archive_path (mode 0600)"
    plan "include .env ($env_bytes bytes, mode 600) from $STACK_DIR/.env"
    plan "include opencode-config ($config_files files, $config_bytes bytes) from $STACK_DIR/opencode-config"
    plan "include opencode-data ($volume_files files, $volume_bytes bytes) from $VOLUME_SOURCE"
    plan "include artifacts ($artifacts_files files, $artifacts_bytes bytes) from $STACK_DIR/disks/artifacts"
    plan "include workspace ($workspace_files files, $workspace_bytes bytes) from $STACK_DIR/disks/workspace"
    plan "include memory ($memory_files files, $memory_bytes bytes) from $STACK_DIR/disks/memory"
    plan "require about $((total / 1024 + total / 20480 + 1)) KiB free in $OUT_DIR"
    plan "write manifest.txt and checksums.sha256 into the archive and beside it"
    prune_archives
    note "dry run: nothing was written, copied, hashed or removed"
    return 0
  fi

  require_space "$total"
  install -d -m 700 "$OUT_DIR"
  stage=$(mktemp -d "${TMPDIR:-/tmp}/openchat-backup.XXXXXX")
  MANIFEST_TMP="$stage/manifest.txt"
  # shellcheck disable=SC2064 # the path is fixed here on purpose
  trap "rm -rf '$stage'" EXIT
  mkdir -p "$stage/volume"
  [ "${VOLUME_UNRESOLVED:-0}" -ne 0 ] || cp -a "$VOLUME_SOURCE" "$stage/volume/opencode-data"

  manifest_row() { printf '%-10s %-16s %14s %8s  %s\n' "$1" "$2" "$3" "$4" "$5"; }
  {
    printf 'openchat backup\ncreated: %s\nhost: %s\nstack: %s\narchive: %s\nformat: 1\n\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname 2>/dev/null || printf unknown)" \
      "$STACK_DIR" "$archive_name"
    printf 'No value from .env is copied into this manifest; it lists paths,\nsizes and counts only.\n\n'
    manifest_row kind path bytes files source
    manifest_row file .env "$env_bytes" 1 "$STACK_DIR/.env (mode $(file_mode "$STACK_DIR/.env"))"
    manifest_row dir opencode-config "$config_bytes" "$config_files" "$STACK_DIR/opencode-config"
    manifest_row volume opencode-data "$volume_bytes" "$volume_files" "$VOLUME_SOURCE"
    manifest_row dir artifacts "$artifacts_bytes" "$artifacts_files" "$STACK_DIR/disks/artifacts"
    manifest_row dir workspace "$workspace_bytes" "$workspace_files" "$STACK_DIR/disks/workspace"
    manifest_row dir memory "$memory_bytes" "$memory_files" "$STACK_DIR/disks/memory"
  } > "$MANIFEST_TMP"

  {
    ( cd "$STACK_DIR" && find .env opencode-config -type f -print0 |
        LC_ALL=C sort -z | xargs -0 -r "${HASH_CMD[@]}" )
    ( cd "$STACK_DIR/disks" && find artifacts workspace memory -type f -print0 |
        LC_ALL=C sort -z | xargs -0 -r "${HASH_CMD[@]}" )
    ( cd "$stage/volume" && find opencode-data -type f -print0 |
        LC_ALL=C sort -z | xargs -0 -r "${HASH_CMD[@]}" )
  } > "$stage/checksums.sha256"
  checksum_lines=$(grep -c . "$stage/checksums.sha256" || true)

  tmp_archive="$OUT_DIR/.$archive_name.part"
  if ! tar -czf "$tmp_archive" \
      -C "$stage" manifest.txt checksums.sha256 \
      -C "$STACK_DIR" .env opencode-config \
      -C "$STACK_DIR/disks" artifacts workspace memory \
      -C "$stage/volume" opencode-data; then
    rm -f "$tmp_archive"
    die "tar failed while reading the stack (live writes?); no archive was kept. Use a quiet window."
  fi
  if ! tar -tzf "$tmp_archive" >/dev/null 2>&1; then
    rm -f "$tmp_archive"
    die "the new archive does not list; no archive was kept"
  fi
  chmod 600 "$tmp_archive"
  mv -f "$tmp_archive" "$archive_path"
  write_sidecars "$archive_path"
  note "backup: $archive_path ($(file_bytes "$archive_path") bytes, $checksum_lines checksums)"
  note "sources: .env, opencode-config, opencode-data, artifacts, workspace, memory"
  prune_archives
}

# Refuse absolute paths, '..' segments and unexpected top-level entries before
# extraction, so a tampered archive cannot write outside the temp directory.
archive_is_safe() {
  local listing
  listing=$(tar -tzf "$1" 2>/dev/null) || return 1
  printf '%s\n' "$listing" | grep -Eq '(^/|(^|/)\.\.(/|$))' && return 1
  if printf '%s\n' "$listing" | cut -d/ -f1 | grep -Evq '^(manifest\.txt|checksums\.sha256|\.env|opencode-config|opencode-data|artifacts|workspace|memory)$'; then
    return 1
  fi
  return 0
}

restore_check() {
  local archive tmp verified
  resolve_stack
  if [ -n "$ARCHIVE_ARG" ]; then
    archive=$ARCHIVE_ARG
  else
    archive=$(archive_names | tail -n 1)
    [ -n "$archive" ] || die "no $PREFIX-*.tar.gz archive in $OUT_DIR"
    archive="$OUT_DIR/$archive"
  fi
  { [ -f "$archive" ] && [ -r "$archive" ]; } || die "archive not found or not readable: $archive"
  if [ -f "$archive.sha256" ]; then
    ( cd "${archive%/*}" && "${HASH_CMD[@]}" -c "${archive##*/}.sha256" >/dev/null ) ||
      die "archive digest does not match ${archive##*/}.sha256"
    note "restore-check: archive digest matches ${archive##*/}.sha256"
  else
    warn "no ${archive##*/}.sha256; verifying the payload checksums only"
  fi
  archive_is_safe "$archive" ||
    die "archive contains an absolute path, a '..' segment or an unexpected top-level entry"

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/openchat-restore-check.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  tar -xzf "$archive" -C "$tmp" || die "extraction failed: $archive"
  [ -f "$tmp/manifest.txt" ] || die "archive has no manifest.txt"
  [ -f "$tmp/checksums.sha256" ] || die "archive has no checksums.sha256"
  if ! ( cd "$tmp" && "${HASH_CMD[@]}" -c checksums.sha256 >/dev/null 2>"$tmp/verify.log" ); then
    printf '%s: checksum verification failed in %s\n' "$PROG" "${archive##*/}" >&2
    grep -E 'FAILED|No such file' "$tmp/verify.log" 2>/dev/null >&2 || true
    exit 1
  fi
  verified=$(grep -c . "$tmp/checksums.sha256" || true)
  note "restore-check: ${archive##*/} -> $verified file(s) verified in $tmp"
  note "restore-check: sources in manifest:"
  sed -n '/^kind /,$p' "$tmp/manifest.txt" | sed 's/^/  /'
  note "restore-check: live data was not touched"
}

main() {
  parse_args "$@"
  detect_tools
  if [ "$RESTORE_CHECK" -eq 1 ]; then restore_check; return 0; fi
  create_backup
}

main "$@"
