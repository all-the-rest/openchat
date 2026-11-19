#!/bin/sh
#
# Boot guard for the OpenChat stack: stop this stack when a disk did not mount.
#
# `openchat-disks.service` runs `Before=docker.service`, but ordering alone does
# not stop Docker when a mount fails. Docker then starts this project again
# (`restart: unless-stopped`) without re-evaluating the `disks-ready` gate, so
# the containers would run on empty bind directories. This script runs after
# Docker and checks the three `.openchat-disk` markers that `mount-disks.sh`
# writes inside each mounted image. Any missing marker means the stack is
# stopped with `docker compose … stop`, scoped to `--project-name openchat`:
# the host's twelve other sites on the same daemon are not touched.
#
# There is deliberately no `/etc/systemd/system/docker.service.d/` drop-in and
# no `Requires=docker.service` anywhere: stopping Docker itself would take the
# unrelated sites down when only this stack's storage failed. The guard unit is
# `openchat-guard.service`; `deploy/remote/deploy.sh` installs and enables it.
#
# Always exits 0, so a failed mount does not add a second boot failure. The
# stopped stack is the signal; a missing compose file or `.env` is only logged.
#
# Run on the host at boot (and by hand); it needs no arguments.

set -u

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
DRY_RUN=0
MARKER=.openchat-disk

usage() {
  cat <<'EOF'
Stop the OpenChat stack when a loopback disk image did not mount.

Usage:
  openchat-guard.sh [options]

Options:
  --stack-dir DIR  stack root (default: /opt/stacks/openchat)
  --dry-run        print what would run; start nothing and stop nothing
  --help

Exit status is always 0: a boot guard must not fail the boot. The stack being
stopped is the visible outcome.
EOF
}

note() { printf '%s: %s\n' "$PROG" "$*"; }

warn() { printf '%s: %s\n' "$PROG" "$*" >&2; }

require_value() {
  [ "$#" -ge 2 ] || { warn "$1 needs a value"; exit 2; }
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) warn "unknown argument: $1"; exit 2 ;;
    esac
  done
}

# The one mutation: stop this compose project only. `--profile "*"` includes the
# profiled services (opencode, toolbox, dind), so a dind-enabled stack stops as
# a whole. A failure is logged; the guard still exits 0.
stop_stack() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'would: docker compose --project-name openchat --env-file %s --file %s --profile "*" stop\n' \
      "$STACK_DIR/.env" "$STACK_DIR/current/compose.yaml"
    return 0
  fi
  if docker compose --project-name openchat \
    --env-file "$STACK_DIR/.env" \
    --file "$STACK_DIR/current/compose.yaml" \
    --profile "*" stop; then
    note "stopped the OpenChat stack: a disk marker was missing"
  else
    warn "docker compose stop failed; the stack may still be running"
  fi
}

main() {
  parse_args "$@"

  missing=""
  for name in artifacts workspace dind memory; do
    marker="$STACK_DIR/disks/$name/$MARKER"
    if [ ! -f "$marker" ]; then
      warn "missing disk marker: $marker"
      missing="$missing $name"
    fi
  done

  # All three images are mounted and marked: silent success, the normal boot.
  [ -z "$missing" ] && exit 0

  if [ ! -f "$STACK_DIR/current/compose.yaml" ]; then
    warn "cannot stop the stack: missing $STACK_DIR/current/compose.yaml"
    exit 0
  fi
  if [ ! -f "$STACK_DIR/.env" ]; then
    warn "cannot stop the stack: missing $STACK_DIR/.env"
    exit 0
  fi

  stop_stack
  exit 0
}

main "$@"
