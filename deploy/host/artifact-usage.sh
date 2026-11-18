#!/bin/sh
#
# Disk usage alert for the OpenChat artifacts volume (issue #36).
#
# The 2 GiB artifact budget is an ext4 loop image, not a Compose volume quota:
# the kernel fails the write with ENOSPC and the BFF turns that into a 500.
# This guard is alert-only by design. It prints one line above the threshold
# and deletes nothing; eviction policy is an owner decision, not a timer's.
#
# A missing mount (the stack is not deployed or the disk is unmounted) logs and
# exits 0, like every other host guard here.

set -eu

PROG=artifact-usage
STACK_DIR=/opt/stacks/openchat
WARN_PERCENT=90

usage() {
  cat <<'EOF'
Warn when the OpenChat artifacts disk is nearly full.

Usage:
  artifact-usage.sh [options]

Options:
  --stack-dir DIR     stack root; the disk is DIR/disks/artifacts
                      (default: /opt/stacks/openchat)
  --warn-percent PCT  print a warning at or above this percentage (default: 90)
  --help
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

log() { printf '%s: %s\n' "$PROG" "$*"; }

warn() { printf '%s: warning: %s\n' "$PROG" "$*" >&2; }

require_value() {
  [ "$#" -ge 2 ] || die "$1 needs a value"
}

validate_dir() {
  case "$STACK_DIR" in
    /*) ;;
    *) die "--stack-dir must be an absolute path: $STACK_DIR" ;;
  esac
  case "$STACK_DIR" in
    *[[:cntrl:]]*) die "--stack-dir must not contain control characters" ;;
  esac
  case "/$STACK_DIR/" in
    */../*) die "--stack-dir must not contain a '..' segment: $STACK_DIR" ;;
  esac
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --warn-percent) require_value "$@"; WARN_PERCENT=$2; shift 2 ;;
      --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  case "$WARN_PERCENT" in
    ""|*[!0-9]*) die "--warn-percent must be a whole number: $WARN_PERCENT" ;;
  esac
  if [ "$WARN_PERCENT" -lt 1 ] || [ "$WARN_PERCENT" -gt 100 ]; then
    die "--warn-percent must be between 1 and 100: $WARN_PERCENT"
  fi
  validate_dir
}

main() {
  parse_args "$@"

  artifacts_dir=$STACK_DIR/disks/artifacts
  if [ ! -d "$artifacts_dir" ]; then
    log "$artifacts_dir is not a directory; the artifacts disk is not mounted, nothing to check"
    exit 0
  fi

  # POSIX df: `Capacity` is field 5 and carries the percent sign. Computing it
  # from used/(used+available) instead would floor 90.9 % to 90 and miss the
  # warning by one tick.
  percent=$(df -P -k "$artifacts_dir" 2>/dev/null |
    awk 'NR == 2 { gsub(/%/, "", $5); if ($5 ~ /^[0-9]+$/) print $5 }') || percent=""

  if [ -z "$percent" ]; then
    warn "cannot read disk usage of $artifacts_dir; nothing done"
    exit 0
  fi

  if [ "$percent" -ge "$WARN_PERCENT" ]; then
    log "WARNING: artifacts disk ${percent}% used (threshold ${WARN_PERCENT}%) at $artifacts_dir; no files were deleted"
  fi
  exit 0
}

main "$@"
