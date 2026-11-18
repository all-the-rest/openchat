#!/usr/bin/env bash
#
# Read-only status probes for the deployed OpenChat stack (issue #9, M7).
#
# One line per signal: release, containers, uptime, healthz, restarts, disk,
# ram (and logs with --logs N). Every probe reads. The script starts no
# container, touches no file, calls no external service and needs no credential:
# it reads the BFF's /healthz and the compose health checks via `docker inspect`,
# plus the host counters a container cannot see.
#
# A FAIL line is an outage (non-zero exit); a warn line is degradation and
# still exits 0, because a restart after a deploy is routine. Signal meanings
# are in docs/implementation/28-operations.md ("Signals").
#
# Usage: status.sh [options]
# Exit codes: 0 every probe ok or warn, 1 at least one probe failed, 2 usage.

set -euo pipefail

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
PROJECT=openchat
BASE_URL=""
HEALTHZ_TIMEOUT=5
DISK_WARN=85
DISK_CRIT=95
RESTART_MAX=3
RAM_WARN=10
RAM_CRIT=5
MEMINFO=/proc/meminfo
LOGS=0
EXPECT="bff,code-host,artifact-host,documents,opencode"

FAILURES=0

usage() {
  cat <<'EOF'
Print one read-only status line per signal.
Usage: status.sh [options]
Options:
  --stack-dir DIR   stack root (default: /opt/stacks/openchat)
  --project NAME    compose project name (default: openchat)
  --base-url URL    BFF URL (default: http://127.0.0.1:${BFF_PORT:-8787} from .env)
  --expect LIST     services that must run
                    (default: bff,code-host,artifact-host,documents,opencode)
  --disk-warn PCT   warn at or above this disk use (default: 85)
  --disk-crit PCT   fail at or above this disk use (default: 95)
  --restart-max N   fail above this RestartCount (default: 3)
  --ram-warn PCT    warn below this MemAvailable share (default: 10)
  --ram-crit PCT    fail below this MemAvailable share (default: 5)
  --meminfo FILE    memory info (default: /proc/meminfo; missing is a skip)
  --logs N              after the probes, tail N lines of every failing
                        container (default: 0, do not read logs)
  --help

Exit 0 when every signal is ok or warn, 1 when one failed, 2 on a usage error.
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

require_value() {
  [ "$#" -ge 2 ] || die "$1 needs a value"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --project) require_value "$@"; PROJECT=$2; shift 2 ;;
      --base-url) require_value "$@"; BASE_URL=$2; shift 2 ;;
      --expect) require_value "$@"; EXPECT=$2; shift 2 ;;
      --disk-warn) require_value "$@"; DISK_WARN=$2; shift 2 ;;
      --disk-crit) require_value "$@"; DISK_CRIT=$2; shift 2 ;;
      --restart-max) require_value "$@"; RESTART_MAX=$2; shift 2 ;;
      --ram-warn) require_value "$@"; RAM_WARN=$2; shift 2 ;;
      --ram-crit) require_value "$@"; RAM_CRIT=$2; shift 2 ;;
      --meminfo) require_value "$@"; MEMINFO=$2; shift 2 ;;
      --logs) require_value "$@"; LOGS=$2; shift 2 ;;
      --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  case "$STACK_DIR" in
    /*) ;;
    *) die "--stack-dir must be an absolute path: $STACK_DIR" ;;
  esac
  local pair
  for pair in "disk-warn:$DISK_WARN" "disk-crit:$DISK_CRIT" "ram-warn:$RAM_WARN" \
      "ram-crit:$RAM_CRIT" "restart-max:$RESTART_MAX" "logs:$LOGS"; do
    case "${pair#*:}" in
      ""|*[!0-9]*) die "--${pair%%:*} must be a non-negative integer: ${pair#*:}" ;;
    esac
  done
  [ "$DISK_WARN" -le "$DISK_CRIT" ] || die "--disk-warn must not exceed --disk-crit"
  [ "$RAM_WARN" -ge "$RAM_CRIT" ] || die "--ram-warn must not be below --ram-crit"
}

signal() {
  # signal state detail
  printf '%-10s %-4s %s\n' "$1" "$2" "$3"
}

ok_signal() { signal "$1" ok "$2"; }

warn_signal() { signal "$1" warn "$2"; }

fail_signal() {
  signal "$1" FAIL "$2"
  FAILURES=$((FAILURES + 1))
}

skip_signal() { signal "$1" skip "$2"; }

# Every docker query goes through here, so a missing daemon is one failure
# instead of a crash in the middle of the probe set.
docker_out() {
  docker "$@" 2>/dev/null
}

probe_release() {
  local current release tag
  if [ ! -d "$STACK_DIR" ]; then
    fail_signal release "stack directory not found: $STACK_DIR"
    return 0
  fi
  current=$(readlink "$STACK_DIR/current" 2>/dev/null || true)
  if [ -z "$current" ]; then
    fail_signal release "no current release link in $STACK_DIR"
    return 0
  fi
  release=${current#releases/}
  if [ ! -d "$STACK_DIR/$current" ]; then
    fail_signal release "current -> $release, but that directory is missing"
    return 0
  fi
  tag=$(sed -n '1p' "$STACK_DIR/$current/tag" 2>/dev/null | tr -d '\r' || true)
  ok_signal release "current -> $release (tag ${tag:-unknown})"
}

# Fills PS_OUT (name|service|state|status) and INSPECT_OUT (name|state|health|
# restarts): one docker call each, no fork per lookup.
collect_containers() {
  local names
  PS_OUT=""
  INSPECT_OUT=""
  DOCKER_OK=1
  command -v docker >/dev/null 2>&1 || { DOCKER_OK=0; return 0; }
  PS_OUT=$(docker_out ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}|{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Status}}' || true)
  names=$(printf '%s\n' "$PS_OUT" | cut -d'|' -f1 | grep . || true)
  [ -n "$names" ] || return 0
  # shellcheck disable=SC2086 # docker's own one-word names; no quotes or spaces
  INSPECT_OUT=$(docker_out inspect \
    --format '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' \
    $names || true)
}

# name -> field. ps fields: 2 service, 3 state, 4 status. inspect fields:
# 2 status, 3 health, 4 restart count. Pure bash: no fork per lookup.
ps_get() {
  local name=$1 field=$2 parts
  while IFS='|' read -r -a parts; do
    [ "${parts[0]}" = "$name" ] && { printf '%s' "${parts[$((field - 1))]}"; return 0; }
  done <<EOF
$PS_OUT
EOF
}
ps_service() {
  local wanted=$1 parts
  while IFS='|' read -r -a parts; do
    [ "${parts[1]}" = "$wanted" ] && { printf '%s' "${parts[0]}"; return 0; }
  done <<EOF
$PS_OUT
EOF
}
inspect_get() {
  local name=$1 field=$2 parts
  while IFS='|' read -r -a parts; do
    [ "${parts[0]#/}" = "$name" ] && { printf '%s' "${parts[$((field - 1))]}"; return 0; }
  done <<EOF
$INSPECT_OUT
EOF
}

probe_containers() {
  local service name status health count=0 healthy=0 missing="" not_running="" unhealthy=""
  local expected total
  [ "$DOCKER_OK" -eq 1 ] || { fail_signal containers "docker is not installed"; return 0; }
  expected=$(printf '%s' "$EXPECT" | tr ',' ' ')
  for service in $expected; do
    name=$(ps_service "$service")
    if [ -z "$name" ]; then
      missing="$missing $service"
      continue
    fi
    count=$((count + 1))
    status=$(inspect_get "$name" 2)
    [ -n "$status" ] || status=$(ps_get "$name" 3)
    health=$(inspect_get "$name" 3)
    [ "$health" = "healthy" ] && healthy=$((healthy + 1))
    [ "$status" != "running" ] && not_running="$not_running $service($status)"
    [ "$health" = "unhealthy" ] && unhealthy="$unhealthy $service"
  done
  total=$(printf '%s\n' "$expected" | wc -w | tr -d ' ')

  local problems=""
  [ -z "$missing" ] || problems="$problems missing:$missing"
  [ -z "$not_running" ] || problems="$problems not running:$not_running"
  [ -z "$unhealthy" ] || problems="$problems unhealthy:$unhealthy"
  if [ -n "$problems" ]; then
    fail_signal containers "${problems# } ($count/$total found)"
    return 0
  fi
  ok_signal containers "$count/$total running, $healthy healthy"
}

probe_uptime() {
  local name status restarts
  name=$(ps_service bff)
  if [ -z "$name" ]; then
    fail_signal uptime "bff container not found"
    return 0
  fi
  status=$(ps_get "$name" 4)
  restarts=$(inspect_get "$name" 4)
  case "$status" in Up*) ok_signal uptime "$status; restarts ${restarts:-0}" ;;
    *) fail_signal uptime "bff is not up: ${status:-unknown}" ;; esac
}

probe_healthz() {
  local port raw code body compact mode version
  if [ -z "$BASE_URL" ]; then
    port=""
    if [ -f "$STACK_DIR/.env" ]; then
      port=$(sed -n 's/^BFF_PORT=//p' "$STACK_DIR/.env" 2>/dev/null |
        tail -n 1 | tr -d '"' | tr -d '[:space:]')
    fi
    BASE_URL="http://127.0.0.1:${port:-8787}"
  fi
  raw=$(curl --silent --show-error --max-time "$HEALTHZ_TIMEOUT" \
    --write-out '\n%{http_code}' "$BASE_URL/healthz" 2>/dev/null || true)
  code=${raw##*$'\n'}
  body=${raw%$'\n'*}
  [ -n "$code" ] || { fail_signal healthz "$BASE_URL/healthz did not answer (timeout ${HEALTHZ_TIMEOUT}s)"; return 0; }
  [ "$code" = "200" ] || { fail_signal healthz "$BASE_URL/healthz answered $code"; return 0; }
  compact=$(printf '%s' "$body" | tr -d '[:space:]')
  case "$compact" in
    *'"ok":true'*) ;;
    *) fail_signal healthz "$BASE_URL/healthz answered 200 without {\"ok\":true}"; return 0 ;;
  esac
  mode=$(printf '%s' "$compact" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')
  version=$(printf '%s' "$compact" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  if [ "$mode" = "fake" ]; then
    warn_signal healthz "200 ok:true, mode fake (a deployed stack must be live), version ${version:-unknown}"
  else
    ok_signal healthz "200 ok:true, mode ${mode:-unknown}, version ${version:-unknown}"
  fi
}

probe_restarts() {
  local name service restarts over="" detail=""
  if [ "$DOCKER_OK" -ne 1 ]; then
    fail_signal restarts "docker is not installed"
    return 0
  fi
  while IFS='|' read -r name service _; do
    [ -n "$name" ] || continue
    restarts=$(inspect_get "$name" 4)
    [ -n "$restarts" ] || restarts=0
    detail="$detail ${service:-$name}=$restarts"
    [ "$restarts" -gt "$RESTART_MAX" ] && over="$over ${service:-$name}($restarts)"
  done <<EOF
$PS_OUT
EOF
  [ -n "$detail" ] || { fail_signal restarts "no containers for project $PROJECT"; return 0; }
  if [ -n "$over" ]; then fail_signal restarts "over --restart-max $RESTART_MAX:$over"
  else ok_signal restarts "$detail"; fi
}

# One line for every mount; the worst state decides the signal's state.
probe_disk() {
  local worst=ok detail="" path label percent available_kb size_kb
  local fs blocks used capacity mount
  local paths=("/" "$STACK_DIR")
  for path in "$STACK_DIR/disks/artifacts" "$STACK_DIR/disks/workspace" \
      "$STACK_DIR/disks/dind"; do
    [ -d "$path" ] && paths+=("$path")
  done

  for path in "${paths[@]}"; do
    [ -d "$path" ] || continue
    read -r fs blocks used available_kb capacity mount <<EOF
$(df -P -k "$path" 2>/dev/null | tail -n 1)
EOF
    percent=${capacity%\%}
    size_kb=$blocks
    case "$percent" in
      ""|*[!0-9]*)
        fail_signal disk "cannot read df for $path"
        return 0
        ;;
    esac
    label=$path
    [ "$path" = "$STACK_DIR" ] && label="stack"
    detail="$detail, $label ${percent}%"
    if [ "$percent" -ge "$DISK_CRIT" ]; then
      worst=fail
      detail="$detail (critical)"
    elif [ "$percent" -ge "$DISK_WARN" ] && [ "$worst" = "ok" ]; then
      worst=warn
    fi
    # KiB -> GiB, one decimal; used in the docs' budget table.
    if [ -n "$available_kb" ] && [ -n "$size_kb" ]; then
      detail="$detail $(LC_ALL=C awk -v a="$available_kb" -v s="$size_kb" 'BEGIN { printf "(%.1f/%.1f GiB free)", a/1048576, s/1048576 }')"
    fi
  done
  [ -n "$detail" ] || { fail_signal disk "no readable mount for $STACK_DIR"; return 0; }
  case "$worst" in
    fail) fail_signal disk "warn $DISK_WARN%, crit $DISK_CRIT%: ${detail#, }" ;;
    warn) warn_signal disk "warn $DISK_WARN%, crit $DISK_CRIT%: ${detail#, }" ;;
    *) ok_signal disk "warn $DISK_WARN%, crit $DISK_CRIT%: ${detail#, }" ;;
  esac
}

probe_ram() {
  local available total percent
  if [ ! -r "$MEMINFO" ]; then
    skip_signal ram "no $MEMINFO (not a Linux host?); not a failure"
    return 0
  fi
  available=$(awk '/^MemAvailable:/ { print int($2 / 1024); exit }' "$MEMINFO" 2>/dev/null || true)
  total=$(awk '/^MemTotal:/ { print int($2 / 1024); exit }' "$MEMINFO" 2>/dev/null || true)
  case "$available$total" in
    ""|*[!0-9]*) skip_signal ram "no usable MemAvailable/MemTotal in $MEMINFO"; return 0 ;;
  esac
  [ "$total" -gt 0 ] || { skip_signal ram "MemTotal is zero in $MEMINFO"; return 0; }
  percent=$((available * 100 / total))
  if [ "$percent" -lt "$RAM_CRIT" ]; then
    fail_signal ram "$available MiB of $total MiB available ($percent%), below crit $RAM_CRIT%"
  elif [ "$percent" -lt "$RAM_WARN" ]; then
    warn_signal ram "$available MiB of $total MiB available ($percent%), below warn $RAM_WARN%"
  else
    ok_signal ram "$available MiB of $total MiB available ($percent%)"
  fi
}
# Not a check: a tail of containers the other probes already flagged, only with
# --logs N, so the default output stays one line per signal.
probe_logs() {
  local name service status health tailed=0 failing=""
  [ "$LOGS" -gt 0 ] || return 0
  if [ "$DOCKER_OK" -ne 1 ]; then
    skip_signal logs "docker is not installed"
    return 0
  fi
  while IFS='|' read -r name service _ _; do
    [ -n "$name" ] || continue
    status=$(inspect_get "$name" 2)
    health=$(inspect_get "$name" 3)
    [ "$status" = "running" ] && [ "$health" != "unhealthy" ] && continue
    failing="$failing $name"
    tailed=$((tailed + 1))
  done <<EOF
$PS_OUT
EOF
  if [ -z "$failing" ]; then
    ok_signal logs "no failing container to tail"
    return 0
  fi
  warn_signal logs "tailing $LOGS line(s) from:$failing"
  for name in $failing; do
    printf -- '--- %s (last %s lines)\n' "$name" "$LOGS"
    docker_out logs --tail "$LOGS" "$name" || printf '%s: could not read logs of %s\n' "$PROG" "$name" >&2
  done
}

main() {
  parse_args "$@"
  probe_release
  collect_containers
  probe_containers
  probe_uptime
  probe_healthz
  probe_restarts
  probe_disk
  probe_ram
  probe_logs
  [ "$FAILURES" -eq 0 ] && return 0
  return 1
}

main "$@"
