#!/bin/sh
#
# Image garbage collection inside the OpenChat rootless dind daemon (issue #36).
#
# The daemon is a compose service on the internal `openchat_dind` network and
# publishes no port: tcp://dind:2375 resolves only between containers on that
# bridge. A host-side `docker` CLI therefore cannot reach it. This script runs a
# one-shot container on the same bridge with the `dind` profile's own pinned
# image, so no extra image has to be pulled:
#
#   docker run --rm --network openchat_dind \
#     -e DOCKER_HOST=tcp://dind:2375 \
#     --entrypoint docker docker:27-dind-rootless \
#     image prune -af --filter until=168h
#
# The retention maximum is the age filter (--max-age-hours, default 168 h).
# Images in use are never removed by `image prune`; the 4 GiB dind loop remains
# the hard disk bound. When dind is not running (the profile is off by default)
# the script logs and exits 0: a missing optional service is not a failure.

set -eu

PROG=dind-gc
PROJECT=openchat
NETWORK=openchat_dind
IMAGE=docker:27-dind-rootless@sha256:e2ac8e8f66ae21a060b0a8e3005c70f6ed9441aabf409434463d1f6eecd38026
MAX_AGE_HOURS=168
DRY_RUN=0

usage() {
  cat <<'EOF'
Prune unused images inside the rootless dind daemon of the OpenChat stack.

Usage:
  dind-gc.sh [options]

Options:
  --network NAME          compose network the daemon listens on
                          (default: openchat_dind)
  --image IMAGE           image that provides the Docker CLI inside the network
                          (default: the digest the dind profile pins)
  --max-age-hours HOURS   keep images newer than this (default: 168)
  --dry-run               print the command; prune nothing
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

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --network) require_value "$@"; NETWORK=$2; shift 2 ;;
      --image) require_value "$@"; IMAGE=$2; shift 2 ;;
      --max-age-hours) require_value "$@"; MAX_AGE_HOURS=$2; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  case "$MAX_AGE_HOURS" in
    ""|*[!0-9]*) die "--max-age-hours must be a whole number: $MAX_AGE_HOURS" ;;
  esac
  [ "$MAX_AGE_HOURS" -gt 0 ] || die "--max-age-hours must be positive: $MAX_AGE_HOURS"
}

main() {
  parse_args "$@"

  if ! command -v docker >/dev/null 2>&1; then
    warn "docker is not on PATH; nothing done"
    exit 0
  fi

  running=$(docker ps -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=dind" 2>/dev/null) || running=""

  if [ -z "$running" ]; then
    log "the dind service is not running; nothing to prune"
    exit 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "would: docker run --rm --network $NETWORK -e DOCKER_HOST=tcp://dind:2375 --entrypoint docker $IMAGE image prune -af --filter until=${MAX_AGE_HOURS}h"
    exit 0
  fi

  if docker run --rm --network "$NETWORK" \
    -e DOCKER_HOST=tcp://dind:2375 \
    --entrypoint docker "$IMAGE" \
    image prune -af --filter "until=${MAX_AGE_HOURS}h"; then
    log "pruned unused images older than ${MAX_AGE_HOURS}h inside dind"
  else
    warn "dind image prune failed; the stack is unaffected"
  fi
  exit 0
}

main "$@"
