#!/usr/bin/env bash
#
# Atomic deploy for the OpenChat stack (issue #20).
#
# Layout this script expects and maintains:
#
#   $STACK_DIR/
#     .env                     host-only secrets (0600, never committed)
#     compose.yaml             optional: the committed baseline for reference
#     releases/<name>/compose.yaml
#     current -> releases/<name>     what compose runs now
#     previous -> releases/<name>    the release that ran before `current`
#
# A swap is: static-validate the candidate, prepare its images, point `current`
# at it, recreate the stack, then probe it. A failed probe restores the previous
# symlink and recreates the previous stack, so the failure window is one
# container recreate, not a broken deployment.
#
# Secrets never leave the environment file: they are read through
# `docker compose --env-file`, never placed on a command line or echoed.
#
# Usage:
#   deploy/swap.sh --release releases/<name> [options]
#
# Options:
#   --stack-dir DIR       stack root (default: current directory)
#   --release DIR         candidate release, must live inside the stack root
#   --project NAME        compose project name (default: openchat)
#   --prepare pull|build  pull or build the candidate images before the swap
#   --expect-version V    fail the validation unless /healthz reports V
#   --probe-url URL       base URL of the BFF (default http://127.0.0.1:${BFF_PORT:-8787})
#   --timeout SECONDS     probe budget (default 30)
#   --dry-run             print the plan; build, start, probe and link nothing
#   --help
#
# Exit codes: 0 success (or a validated no-op), 1 failed validation/rollback,
# 2 usage error.

set -euo pipefail

PROG=$(basename "$0")
STACK_DIR=$PWD
RELEASE=""
PROJECT=openchat
PREPARE=""
EXPECT_VERSION=""
PROBE_URL=""
TIMEOUT=30
DRY_RUN=0

usage() {
  cat <<'EOF'
Atomic deploy for the OpenChat stack (issue #20).

Usage:
  deploy/swap.sh --release releases/<name> [options]

Options:
  --stack-dir DIR       stack root (default: current directory)
  --release DIR         candidate release, must live inside the stack root
  --project NAME        compose project name (default: openchat)
  --prepare pull|build  pull or build the candidate images before the swap
  --expect-version V    fail the validation unless /healthz reports V
  --probe-url URL       base URL of the BFF (default http://127.0.0.1:${BFF_PORT:-8787})
  --timeout SECONDS     probe budget (default 30)
  --dry-run             print the plan; build, start, probe and link nothing
  --help

Secrets are read from $STACK_DIR/.env through `docker compose --env-file`;
none is accepted as an argument or printed.
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

usage_error() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  printf 'Try %s --help\n' "$PROG" >&2
  exit 2
}

note() {
  printf '%s\n' "$*"
}

plan() {
  printf 'would: %s\n' "$*"
}

require_value() {
  [ "$#" -ge 2 ] || usage_error "$1 needs a value"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir)
        require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --release)
        require_value "$@"; RELEASE=$2; shift 2 ;;
      --project)
        require_value "$@"; PROJECT=$2; shift 2 ;;
      --prepare)
        require_value "$@"; PREPARE=$2; shift 2 ;;
      --expect-version)
        require_value "$@"; EXPECT_VERSION=$2; shift 2 ;;
      --probe-url)
        require_value "$@"; PROBE_URL=$2; shift 2 ;;
      --timeout)
        require_value "$@"; TIMEOUT=$2; shift 2 ;;
      --dry-run)
        DRY_RUN=1; shift ;;
      --help)
        usage; exit 0 ;;
      *)
        usage_error "unknown argument: $1" ;;
    esac
  done

  case "$PREPARE" in
    ""|pull|build) ;;
    *) usage_error "--prepare must be pull or build" ;;
  esac
  case "$TIMEOUT" in
    ""|*[!0-9]*) usage_error "--timeout must be a positive integer" ;;
  esac
  [ -n "$RELEASE" ] || usage_error "--release is required"
}

quote_cmd() {
  local out=""
  local word
  for word in "$@"; do
    out+="${out:+ }$(printf '%q' "$word")"
  done
  printf '%s' "$out"
}

# Runs a mutating command, or prints it in a dry run. The stub-friendly seam for
# tests is the PATH: a fake `docker` or `curl` earlier in PATH is used as-is.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$(quote_cmd "$@")"
    return 0
  fi
  "$@"
}

compose_file_for() {
  printf '%s/%s/compose.yaml' "$STACK_DIR" "$1"
}

compose_from() {
  local release=$1
  shift
  docker compose \
    --project-name "$PROJECT" \
    --env-file "$ENV_FILE" \
    --file "$(compose_file_for "$release")" \
    "$@"
}

# Fills PROBE_CODE and PROBE_BODY_FILE from one HTTP GET. No secret is involved:
# both probes are unauthenticated (liveness) or session-gated but answered by the
# stack itself, and swap.sh never logs a body.
probe() {
  local url=$1
  cleanup
  PROBE_BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/openchat-probe.XXXXXX")
  PROBE_CODE=$(curl --silent --show-error --max-time 5 \
    --output "$PROBE_BODY_FILE" --write-out '%{http_code}' "$url" 2>/dev/null || true)
  PROBE_CODE=${PROBE_CODE:-000}
}

cleanup() {
  if [ -n "${PROBE_BODY_FILE:-}" ] && [ -f "$PROBE_BODY_FILE" ]; then
    rm -f "$PROBE_BODY_FILE"
  fi
}

# The probes read one HTTP body; JSON does not require compact separators, so
# every check runs against the body with whitespace removed. The needle is a
# fixed string, so a dotted version is compared literally, not as a pattern.
body_has() {
  local body
  body=$(tr -d '[:space:]' < "$PROBE_BODY_FILE")
  grep -qF -- "$1" <<<"$body"
}

# Waits for `/healthz`, then checks `/api/info`. A degraded host (OpenCode
# unreachable) still answers 200 with `host.reachable: false` and is allowed: the
# app being up is what a swap validates, not the upstream. `/api/info` sits
# behind the app's auth gate, so an unauthenticated probe accepts `200` and
# `401`: 401 proves the route exists and the guard runs, which is exactly what
# a deploy needs to know without holding a credential (the probe never sends
# one). Anything else — 5xx, 404, a dead socket — fails the candidate.
check_release() {
  local deadline=$((SECONDS + TIMEOUT))
  local version_hit=0

  while :; do
    probe "$PROBE_URL/healthz"
    if [ "$PROBE_CODE" = "200" ] && body_has '"ok":true'; then
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf '%s: /healthz did not become ready in %ss (last status %s)\n' \
        "$PROG" "$TIMEOUT" "$PROBE_CODE" >&2
      return 1
    fi
    sleep 2
  done

  if [ -n "$EXPECT_VERSION" ] && body_has "\"version\":\"$EXPECT_VERSION\""; then
    version_hit=1
  fi

  probe "$PROBE_URL/api/info"
  case "$PROBE_CODE" in
    200)
      if body_has '"reachable":true'; then
        note "validation: app up, host reachable"
      else
        note "validation: app up, host unreachable (degraded, allowed)"
      fi
      ;;
    401)
      # The session guard runs before the route body; no credential is sent by
      # the probe, so 401 is the expected answer on a real deployment.
      note "validation: app up, auth enforced, host unknown"
      ;;
    *)
      printf '%s: /api/info answered %s\n' "$PROG" "$PROBE_CODE" >&2
      return 1
      ;;
  esac

  if [ -n "$EXPECT_VERSION" ] && [ "$version_hit" -ne 1 ]; then
    printf '%s: /healthz does not report version %s\n' "$PROG" "$EXPECT_VERSION" >&2
    return 1
  fi

  return 0
}

# Points `current` back at the release that ran before and recreates it. Uses
# the explicit error path so a failed rollback still exits non-zero.
rollback() {
  local target=$1
  printf '%s: validation failed, rolling back to %s\n' "$PROG" "$target" >&2
  ln -sfn "$target" "$STACK_DIR/current"
  if ! compose_from "$target" up -d --wait --wait-timeout 120; then
    printf '%s: rollback recreate failed; the stack needs manual attention\n' "$PROG" >&2
    return 1
  fi
  if ! check_release; then
    printf '%s: rollback release does not validate either; inspect the host\n' "$PROG" >&2
    return 1
  fi
  printf '%s: rolled back to %s\n' "$PROG" "$target" >&2
  return 1
}

main() {
  parse_args "$@"

  [ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
  STACK_DIR=$(cd "$STACK_DIR" && pwd -P)
  ENV_FILE="$STACK_DIR/.env"

  [ -d "$RELEASE" ] || die "release directory not found: $RELEASE"
  RELEASE_DIR=$(cd "$RELEASE" && pwd -P)
  case "$RELEASE_DIR" in
    "$STACK_DIR"/*) ;;
    *) die "release must live inside $STACK_DIR" ;;
  esac
  RELEASE_REL=${RELEASE_DIR#"$STACK_DIR"/}
  [ -f "$RELEASE_DIR/compose.yaml" ] || die "missing $RELEASE_REL/compose.yaml"
  [ -f "$ENV_FILE" ] || die "missing .env in $STACK_DIR (host-only, mode 0600)"

  if [ -z "$PROBE_URL" ]; then
    # The compose file reads BFF_PORT from .env, so the probe must use the same
    # value: a candidate bound to 8788 would otherwise be validated on 8787,
    # i.e. against the old release.
    local env_port=""
    env_port=$(sed -n 's/^BFF_PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '"' | tr -d '[:space:]')
    PROBE_URL="http://127.0.0.1:${env_port:-8787}"
  fi

  local current previous=""
  current=$(readlink "$STACK_DIR/current" 2>/dev/null || true)
  if [ -e "$STACK_DIR/previous" ]; then
    previous=$(readlink "$STACK_DIR/previous" 2>/dev/null || true)
  fi

  note "stack:    $STACK_DIR"
  note "release:  $RELEASE_REL"
  note "current:  ${current:-<none>}"
  note "previous: ${previous:-<none>}"
  note "probe:    $PROBE_URL"

  if [ -n "$current" ] && [ "$current" = "$RELEASE_REL" ]; then
    note "current already points at $RELEASE_REL"
    if [ "$DRY_RUN" -eq 1 ]; then
      plan "probe $PROBE_URL/healthz and $PROBE_URL/api/info (validate only)"
      note "dry run: nothing was built, started, probed or linked"
      exit 0
    fi
    check_release || die "the running release does not validate"
    note "nothing to do"
    exit 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    plan "docker compose --project-name $PROJECT --env-file .env --file $RELEASE_REL/compose.yaml config -q"
    case "$PREPARE" in
      pull) plan "… pull (candidate images)" ;;
      build) plan "… build (candidate images)" ;;
    esac
    plan "ln -sfn $RELEASE_REL current"
    plan "… up -d --wait --wait-timeout 120 --remove-orphans (candidate)"
    plan "probe $PROBE_URL/healthz and $PROBE_URL/api/info"
    if [ -n "$EXPECT_VERSION" ]; then
      plan "… require version $EXPECT_VERSION in /healthz"
    fi
    if [ -n "$current" ]; then
      plan "on failure: ln -sfn $current current and recreate $current"
    else
      plan "on failure: no previous release, the stack stays on the candidate (inspect the host)"
    fi
    plan "on success: ln -sfn ${current:-<none>} previous"
    note "dry run: nothing was built, started, probed or linked"
    exit 0
  fi

  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  command -v curl >/dev/null 2>&1 || die "curl is not installed"
  trap cleanup EXIT

  compose_from "$RELEASE_REL" config -q

  case "$PREPARE" in
    pull) compose_from "$RELEASE_REL" pull ;;
    build) compose_from "$RELEASE_REL" build ;;
  esac

  ln -sfn "$RELEASE_REL" "$STACK_DIR/current"
  if ! compose_from "$RELEASE_REL" up -d --wait --wait-timeout 120 --remove-orphans; then
    if [ -n "$current" ]; then
      rollback "$current" || exit 1
    fi
    printf '%s: the candidate did not start and there is no previous release; inspect the host\n' \
      "$PROG" >&2
    exit 1
  fi

  if ! check_release; then
    if [ -n "$current" ]; then
      rollback "$current" || exit 1
    fi
    printf '%s: the candidate did not validate and there is no previous release; inspect the host\n' \
      "$PROG" >&2
    exit 1
  fi

  if [ -n "$current" ]; then
    ln -sfn "$current" "$STACK_DIR/previous"
    note "swapped: current -> $RELEASE_REL, previous -> $current"
  else
    note "swapped: current -> $RELEASE_REL (no previous release)"
  fi
  exit 0
}

main "$@"
