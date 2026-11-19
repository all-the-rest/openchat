#!/usr/bin/env bash
#
# Read-only health snapshot of the OpenChat stack (issue #9, milestone M7).
#
# Prints one line per signal and exits non-zero when any probe is down. It never
# starts, stops, restarts or creates a container, never calls a remote service,
# and never writes inside the stack dir. All probes use tools already present
# on the host: curl, docker (inspect/ps/logs) and df. There is no agent, no
# exporter and no external monitoring dependency.
#
# Signals (see docs/implementation/28-operations.md for what each means):
#   healthz    GET /healthz on the loopback BFF port; 200 + "ok":true
#   containers expected compose services listed and Up
#   restarts   max RestartCount across those containers below the threshold
#   disk       used % of each mounted disk image below the threshold
#   ram        MemAvailable at or above the threshold (ram-watchdog's low water)
#   logs       last 100 compose log lines readable; error lines are counted
#
# The probe body is never printed in full and contains no secret: /healthz is
# liveness-only ({ok, mode, version}) and /api/info is not probed here.

set -euo pipefail
export LC_ALL=C

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
PROJECT=openchat
MEMINFO=/proc/meminfo
DISK_WARN=90
RAM_MIN_MIB=900
MAX_RESTARTS=3
FAILED=0
HTTP_CODE=""
HTTP_BODY=""
PROBE_URL=""

usage() {
  cat <<'EOF'
Read-only status snapshot of the OpenChat stack.

Usage:
  status.sh [options]

Options:
  --stack-dir DIR       stack root (default: /opt/stacks/openchat)
  --project NAME        compose project (default: openchat)
  --meminfo FILE        meminfo to read (default: /proc/meminfo)
  --disk-warn PERCENT   disk used % that fails (default: 90)
  --ram-min MIB         MemAvailable floor in MiB (default: 900)
  --max-restarts N      restart count at or above which a probe fails (default: 3)
  --help

Prints one line per signal; exits 1 when any signal is down, else 0.
EOF
}

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
require_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }
usage_error() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  printf 'Try %s --help\n' "$PROG" >&2
  exit 2
}
ok() { printf '%s\n' "$*"; }
bad() { printf '%s\n' "$*"; FAILED=1; }

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --project) require_value "$@"; PROJECT=$2; shift 2 ;;
      --meminfo) require_value "$@"; MEMINFO=$2; shift 2 ;;
      --disk-warn) require_value "$@"; DISK_WARN=$2; shift 2 ;;
      --ram-min) require_value "$@"; RAM_MIN_MIB=$2; shift 2 ;;
      --max-restarts) require_value "$@"; MAX_RESTARTS=$2; shift 2 ;;
      --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done
  local value
  for value in "$DISK_WARN" "$RAM_MIN_MIB" "$MAX_RESTARTS"; do
    case "$value" in
      ""|*[!0-9]*) usage_error "thresholds must be positive integers: $value" ;;
    esac
  done
  validate_path "$STACK_DIR" "--stack-dir"
  [ "$DISK_WARN" -le 100 ] || usage_error "--disk-warn must be 1..100"
}

validate_path() {
  local value=$1 name=$2
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

setup() {
  [ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
  STACK_DIR=$(cd "$STACK_DIR" && pwd -P)
  local env_file="$STACK_DIR/.env"
  [ -r "$env_file" ] || die "missing or unreadable $env_file"
  local bff_port
  bff_port=$(sed -n 's/^BFF_PORT=//p' "$env_file" | tail -n 1 | tr -d '"' | tr -d '[:space:]')
  PROBE_URL="http://127.0.0.1:${bff_port:-8787}"
}

# GET one path; fills HTTP_CODE (000 on failure) and HTTP_BODY. The body is
# captured in one substitution so no temp file or shell side effect is needed.
http_get() {
  local response
  response=$(curl --silent --show-error --max-time 5 --write-out '\n%{http_code}' \
    "$PROBE_URL$1" 2>/dev/null || true)
  HTTP_CODE=${response##*$'\n'}
  case "$HTTP_CODE" in
    [0-9][0-9][0-9]) ;;
    *) HTTP_CODE=000 ;;
  esac
  HTTP_BODY=${response%$'\n'*}
}

probe_healthz() {
  http_get /healthz
  local body version mode
  body=$(printf '%s' "$HTTP_BODY" | tr -d '[:space:]')
  if [ "$HTTP_CODE" = "200" ] && printf '%s' "$body" | grep -qF '"ok":true'; then
    version=$(printf '%s' "$body" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    mode=$(printf '%s' "$body" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')
    ok "healthz: up (HTTP 200, version ${version:-unknown}, mode ${mode:-unknown})"
  else
    bad "healthz: DOWN (HTTP $HTTP_CODE, expected 200 with ok:true)"
  fi
}

# Expected services: the four application services plus the local opencode
# profile the deploy driver runs by default. Profile-only tools/dind are not
# probed: they are optional operator services.
EXPECTED=(bff code-host artifact-host documents opencode)

container_lines() {
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}} {{.Status}}' 2>/dev/null
}

probe_containers() {
  local lines names="" line name service missing="" down=""
  if ! lines=$(container_lines); then
    bad "containers: DOWN (cannot list project $PROJECT)"
    return 0
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=${line%% *}
    names="$names $name "
    case "$line" in
      *Up*) ;;
      *) down="$down $name" ;;
    esac
  done <<<"$lines"
  for service in "${EXPECTED[@]}"; do
    case "$names" in
      *"-$service-"*) ;;
      *) missing="$missing $service" ;;
    esac
  done
  if [ -n "$missing" ] || [ -n "$down" ]; then
    bad "containers: DOWN (missing:$missing not-up:$down)"
  else
    ok "containers: up (${#EXPECTED[@]} expected services present and running)"
  fi
}

probe_restarts() {
  local names="" line name count max=0 worst=""
  if ! names=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}' 2>/dev/null); then
    bad "restarts: DOWN (cannot read container restarts)"
    return 0
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! count=$(docker inspect --format '{{.RestartCount}}' "$name" 2>/dev/null); then
      bad "restarts: DOWN (inspect failed for $name)"
      return 0
    fi
    case "$count" in
      ''|*[!0-9]*) bad "restarts: DOWN (unreadable count for $name)"; return 0 ;;
    esac
    if [ "$count" -gt "$max" ]; then max=$count; worst=$name; fi
  done <<<"$names"
  if [ -n "$worst" ] && [ "$max" -ge "$MAX_RESTARTS" ]; then
    bad "restarts: DOWN (max $max on $worst, limit $MAX_RESTARTS)"
  else
    ok "restarts: ok (max $max in current containers, limit $MAX_RESTARTS)"
  fi
}

probe_disk() {
  local path used worst="" worst_used=0 name
  for name in artifacts workspace dind; do
    path="$STACK_DIR/disks/$name"
    if [ ! -d "$path" ]; then
      bad "disk: DOWN (missing $path)"
      return 0
    fi
    used=$(df -Pk "$path" 2>/dev/null | awk 'NR==2 { gsub(/%/, "", $5); print $5 }')
    case "$used" in
      ''|*[!0-9]*) bad "disk: DOWN (cannot read usage for $path)"; return 0 ;;
    esac
    if [ "$used" -gt "$worst_used" ]; then worst_used=$used; worst=$name; fi
  done
  if [ "$worst_used" -ge "$DISK_WARN" ]; then
    bad "disk: DOWN ($worst_used% used on $worst, warn $DISK_WARN%)"
  else
    ok "disk: ok (max ${worst_used}% used on $worst, warn $DISK_WARN%)"
  fi
}

probe_ram() {
  local available_kib available_mib
  [ -r "$MEMINFO" ] || { bad "ram: DOWN (cannot read $MEMINFO)"; return 0; }
  available_kib=$(awk '/^MemAvailable:/ { print $2; exit }' "$MEMINFO" 2>/dev/null)
  case "$available_kib" in
    ''|*[!0-9]*) bad "ram: DOWN (no MemAvailable in $MEMINFO)"; return 0 ;;
  esac
  available_mib=$((available_kib / 1024))
  if [ "$available_mib" -lt "$RAM_MIN_MIB" ]; then
    bad "ram: DOWN (${available_mib} MiB available, floor $RAM_MIN_MIB MiB)"
  else
    ok "ram: ok (${available_mib} MiB available, floor $RAM_MIN_MIB MiB)"
  fi
}

probe_logs() {
  local output errors
  if ! output=$(docker compose --project-name "$PROJECT" \
    --env-file "$STACK_DIR/.env" --file "$STACK_DIR/current/compose.yaml" \
    logs --tail 100 2>/dev/null); then
    bad "logs: DOWN (cannot tail compose logs)"
    return 0
  fi
  errors=$(printf '%s\n' "$output" | grep -Eic 'error|fatal' || true)
  ok "logs: readable (last 100 lines, $errors error/fatal lines; see runbook to inspect)"
}

main() {
  parse_args "$@"
  setup
  probe_healthz
  probe_containers
  probe_restarts
  probe_disk
  probe_ram
  probe_logs
  exit "$FAILED"
}

main "$@"
