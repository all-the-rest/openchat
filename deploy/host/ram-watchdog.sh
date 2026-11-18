#!/bin/sh
#
# Host memory guard for the OpenChat stack (issue #36).
#
# One tick reads MemAvailable from /proc/meminfo (or --meminfo FILE) and acts
# on the threshold inputs:
#
#   below --low   stop ONLY the `opencode` compose service and record that this
#                 guard did it in $STACK_DIR/ram-watchdog.state
#   above --high  start `opencode` again, but only if that state file exists
#   in between    change nothing; a state file keeps opencode stopped
#
# It never stops bff, code-host, artifact-host, the edge proxy or the Docker
# daemon, and it never restarts a container it did not stop. The threshold is
# the input; there is no wall-clock condition and no PID to watch.
#
# Every expected failure (missing or unreadable meminfo, no compose file, a
# failed compose call) logs and exits 0. A guard that takes the host down when
# its input is missing is worse than no guard.

set -eu

PROG=ram-watchdog
STACK_DIR=/opt/stacks/openchat
MEMINFO=/proc/meminfo
LOW_MIB=900
HIGH_MIB=1200
DRY_RUN=0

usage() {
  cat <<'EOF'
Stop and restart the OpenChat `opencode` service under host memory pressure.

Usage:
  ram-watchdog.sh [options]

Options:
  --stack-dir DIR   stack root, holds current/compose.yaml and the state file
                    (default: /opt/stacks/openchat)
  --meminfo FILE    kernel memory info to read (default: /proc/meminfo)
  --low MIB         stop opencode below this MemAvailable (default: 900)
  --high MIB        start opencode above this MemAvailable (default: 1200)
  --dry-run         print what would happen; change nothing
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
      --meminfo) require_value "$@"; MEMINFO=$2; shift 2 ;;
      --low) require_value "$@"; LOW_MIB=$2; shift 2 ;;
      --high) require_value "$@"; HIGH_MIB=$2; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  case "$LOW_MIB" in
    ""|*[!0-9]*) die "--low must be a whole number of MiB: $LOW_MIB" ;;
  esac
  case "$HIGH_MIB" in
    ""|*[!0-9]*) die "--high must be a whole number of MiB: $HIGH_MIB" ;;
  esac
  [ "$HIGH_MIB" -gt "$LOW_MIB" ] ||
    die "--high must be greater than --low ($LOW_MIB): $HIGH_MIB"
  validate_dir
}

# The release layout: current -> releases/<name>, and compose.yaml lives there.
COMPOSE_FILE=""
STATE_FILE=""

compose_run() {
  if [ -f "$STACK_DIR/.env" ]; then
    env COMPOSE_PROFILES=opencode docker compose --project-name openchat \
      --env-file "$STACK_DIR/.env" --file "$COMPOSE_FILE" "$@"
  else
    env COMPOSE_PROFILES=opencode docker compose --project-name openchat \
      --file "$COMPOSE_FILE" "$@"
  fi
}

write_state() {
  ( umask 077
    printf 'opencode stopped by ram-watchdog at %s; MemAvailable=%s MiB\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "$STATE_FILE" )
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

read_available_mib() {
  awk '
    /^MemAvailable:/ { print int($2 / 1024); found = 1; exit }
    END { if (!found) exit 1 }
  ' "$MEMINFO"
}

main() {
  parse_args "$@"
  COMPOSE_FILE=$STACK_DIR/current/compose.yaml
  STATE_FILE=$STACK_DIR/ram-watchdog.state

  if [ ! -r "$MEMINFO" ]; then
    warn "cannot read $MEMINFO; nothing done"
    exit 0
  fi

  available=$(read_available_mib) || {
    warn "no usable MemAvailable line in $MEMINFO; nothing done"
    exit 0
  }
  case "$available" in
    ""|*[!0-9]*) warn "MemAvailable is not a number in $MEMINFO; nothing done"; exit 0 ;;
  esac

  if [ ! -f "$COMPOSE_FILE" ]; then
    warn "no compose file at $COMPOSE_FILE; nothing done"
    exit 0
  fi

  if [ "$available" -lt "$LOW_MIB" ]; then
    if [ -f "$STATE_FILE" ]; then
      log "MemAvailable ${available} MiB is below low ${LOW_MIB} MiB; opencode is already stopped by this guard"
      exit 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      log "would: stop the opencode service (MemAvailable ${available} MiB < low ${LOW_MIB} MiB)"
      exit 0
    fi
    if compose_run stop opencode; then
      if write_state "$available"; then
        log "MemAvailable ${available} MiB is below low ${LOW_MIB} MiB; stopped opencode and recorded $STATE_FILE"
      else
        warn "stopped opencode but could not write $STATE_FILE; the next tick may stop it again"
      fi
    else
      warn "docker compose stop opencode failed; the state file was not written"
    fi
    exit 0
  fi

  if [ "$available" -gt "$HIGH_MIB" ]; then
    if [ ! -f "$STATE_FILE" ]; then
      exit 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      log "would: start the opencode service (MemAvailable ${available} MiB > high ${HIGH_MIB} MiB)"
      exit 0
    fi
    if compose_run start opencode; then
      rm -f "$STATE_FILE"
      log "MemAvailable ${available} MiB is above high ${HIGH_MIB} MiB; started opencode and cleared the state"
    else
      warn "docker compose start opencode failed; the state file is kept for the next tick"
    fi
    exit 0
  fi

  if [ -f "$STATE_FILE" ]; then
    log "MemAvailable ${available} MiB is inside the ${LOW_MIB}-${HIGH_MIB} MiB band; opencode stays stopped"
  fi
  exit 0
}

main "$@"
