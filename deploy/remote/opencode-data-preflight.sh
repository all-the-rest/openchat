#!/usr/bin/env bash
#
# Refuse to start OpenCode on an empty state disk (issue #43, finding 1).
#
# The remote overlay binds `disks/opencode-data` over
# `/root/.local/share/opencode`, the target the base file's named volume
# `<project>_opencode-data` used. Until `migrate-opencode-data.sh --apply` copied
# the volume onto the disk and stamped it, the volume is the only copy of the
# sessions. A deploy that starts the service anyway creates the first file on the
# disk; the migration then refuses ("holds data and no migration stamp") and the
# documented path to recover without a rollback is gone.
#
# This precondition refuses, and changes nothing, when all of these hold:
#
#   1. the candidate release binds `disks/opencode-data`,
#   2. `disks/opencode-data/.openchat-migrated` is absent,
#   3. `<project>_opencode-data` exists and holds at least one file.
#
# An empty or never-used volume (compose created it, nobody wrote to it), a host
# without the volume and a stamped disk all pass. The content is read with a
# throwaway container, the same way the migration script classifies the volume,
# so a volume directory is never read through a host path.
#
# Usage: opencode-data-preflight.sh --stack-dir DIR --release DIR [options]
# Exit codes: 0 pass (or, in a dry run, a printed plan), 1 refusal or unreadable
# volume, 2 usage error.

set -euo pipefail

# Stable counting: `wc` must not print a decimal separator.
export LC_ALL=C

PROG=$(basename "$0")
STACK_DIR=""
RELEASE_DIR=""
PROJECT=openchat
DISK=opencode-data
# Written inside the image by migrate-opencode-data.sh after a verified copy.
STAMP=.openchat-migrated
# The same pinned image the `disks-ready` gate uses, so the check starts no
# unreviewed registry pull and needs no tool from the OpenCode image.
COPY_IMAGE="alpine:3@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf"
DRY_RUN=0

VOLUME_REF=""

usage() {
  cat <<'EOF'
Refuse to start OpenCode on an empty state disk (issue #43, finding 1).

Usage:
  opencode-data-preflight.sh --stack-dir DIR --release DIR [options]

Options:
  --stack-dir DIR   stack root (default: /opt/stacks/openchat)
  --release DIR     candidate release directory (its compose.yaml is inspected)
  --project NAME    compose project name (default: openchat)
  --dry-run         print what would be checked; run no container
  --help

Exit codes: 0 pass, 1 refusal, 2 usage error. The check only reads: it starts no
service, mounts nothing and writes no file. Output never names a file inside the
volume.
EOF
}

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
usage_error() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  printf 'Try %s --help\n' "$PROG" >&2
  exit 2
}
note() { printf '%s\n' "$*"; }
plan() { printf 'would: %s\n' "$*"; }
require_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --release) require_value "$@"; RELEASE_DIR=$2; shift 2 ;;
      --project) require_value "$@"; PROJECT=$2; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done
  [ -n "$STACK_DIR" ] || usage_error "--stack-dir is required"
  [ -n "$RELEASE_DIR" ] || usage_error "--release is required"
  case "$STACK_DIR" in /*) ;; *) usage_error "--stack-dir must be absolute: $STACK_DIR" ;; esac
  case "$RELEASE_DIR" in /*) ;; *) usage_error "--release must be absolute: $RELEASE_DIR" ;; esac
  case "$PROJECT" in
    ""|*[!A-Za-z0-9_-]*) usage_error "--project must be a compose project name: $PROJECT" ;;
  esac
}

resolve_paths() {
  [ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
  [ -d "$RELEASE_DIR" ] || die "release directory not found: $RELEASE_DIR"
  STACK_DIR=$(cd "$STACK_DIR" && pwd -P)
  RELEASE_DIR=$(cd "$RELEASE_DIR" && pwd -P)
  COMPOSE_FILE=$RELEASE_DIR/compose.yaml
  DISK_DIR=$STACK_DIR/disks/$DISK
  STAMP_PATH=$DISK_DIR/$STAMP
  VOLUME_REF="${PROJECT}_${DISK}"
}

# The migration hint is the whole point of the refusal, so it carries the real
# stack path instead of a placeholder.
migration_command() {
  printf 'deploy/remote/migrate-opencode-data.sh --stack-dir %s --apply' "$STACK_DIR"
}

# The state disk is only a hazard for a release that actually binds it. A
# release that still uses the named volume starts on the volume and is correct.
release_binds_state_disk() {
  [ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"
  grep -q "disks/$DISK" "$COMPOSE_FILE"
}

volume_exists() {
  docker volume inspect --format '{{.Name}}' "$VOLUME_REF" >/dev/null 2>&1
}

# Counts files only, through a read-only bind of the volume: an empty volume or
# one that only holds directories is "no data", exactly like the migration's
# probe. A failing probe is a refusal, never an assumption.
volume_files() {
  local out
  if ! out=$(docker run --rm -v "$VOLUME_REF:/src:ro" "$COPY_IMAGE" \
      sh -c 'find /src -type f | wc -l' 2>/dev/null); then
    return 1
  fi
  out=$(printf '%s\n' "$out" | tail -n 1 | tr -d '[:space:]')
  case "$out" in
    ""|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$out"
}

main() {
  parse_args "$@"
  resolve_paths

  if ! release_binds_state_disk; then
    note "state disk: release ${RELEASE_DIR##*/} does not bind disks/$DISK; nothing to check"
    return 0
  fi
  if [ -e "$STAMP_PATH" ]; then
    note "state disk: migrated ($STAMP present); the disk is the live copy"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "refuse if volume $VOLUME_REF holds files and $STAMP_PATH is absent"
    plan "otherwise pass: an empty, never-used or missing volume does not block"
    return 0
  fi
  command -v docker >/dev/null 2>&1 ||
    die "docker is required to inspect the volume $VOLUME_REF; nothing was started"

  if ! volume_exists; then
    note "state disk: volume $VOLUME_REF does not exist; a fresh host creates the disk with mount-disks.sh"
    return 0
  fi

  local files
  if ! files=$(volume_files); then
    die "cannot read volume $VOLUME_REF through docker (output suppressed; run the same docker run by hand to see why), and $STAMP is absent; run $(migration_command) to classify and copy it. Nothing was started"
  fi
  if [ "$files" -eq 0 ]; then
    note "state disk: volume $VOLUME_REF is empty and $STAMP is absent; the disk may start empty"
    return 0
  fi

  die "refusing to start OpenCode on an empty state disk: volume $VOLUME_REF holds $files file(s), $DISK_DIR carries no $STAMP. Run '$(migration_command)' first. Nothing was changed"
}

main "$@"
