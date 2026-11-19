#!/usr/bin/env bash
#
# Shared fixture and assertion helpers for deploy/remote/test/*.test.sh.
#
# Every test runs against a temporary stack directory and, where a tool would
# touch the host, against a fake binary earlier in PATH. Nothing here needs
# docker, network access or the deployed stack.

set -euo pipefail

LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "$LIB_DIR/../../.." && pwd -P)
BACKUP="$REPO_ROOT/deploy/remote/backup.sh"
STATUS_SH="$REPO_ROOT/deploy/remote/status.sh"
SWAP="$REPO_ROOT/deploy/swap.sh"
DEPLOY="$REPO_ROOT/deploy/remote/deploy.sh"

CLEANUP_DIRS=()

cleanup_dirs() {
  local path
  if [ "${#CLEANUP_DIRS[@]}" -gt 0 ]; then
    for path in "${CLEANUP_DIRS[@]}"; do
      rm -rf "$path"
    done
  fi
}
trap cleanup_dirs EXIT

new_dir() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/openchat-deploy-test.XXXXXX")
  CLEANUP_DIRS+=("$dir")
  printf '%s' "$dir"
}

fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack=$1 needle=$2 label=${3:-output}
  case "$haystack" in
    *"$needle"*) ;;
    *) fail "$label does not contain '$needle'; got: $haystack" ;;
  esac
}

assert_not_contains() {
  local haystack=$1 needle=$2 label=${3:-output}
  case "$haystack" in
    *"$needle"*) fail "$label must not contain '$needle'" ;;
  esac
}

assert_file() {
  [ -f "$1" ] || fail "expected file: $1"
}

assert_missing() {
  [ ! -e "$1" ] || fail "expected no path: $1"
}

assert_eq() {
  [ "$1" = "$2" ] || fail "${3:-value}: expected '$2', got '$1'"
}

# Runs a command, capturing stdout+stderr in OUTPUT and its status in RUN_STATUS.
run_capture() {
  set +e
  OUTPUT=$("$@" 2>&1)
  RUN_STATUS=$?
  set -e
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# The stack layout the backup and status scripts expect, filled with one small
# file per source. SENTINEL_SECRET_VALUE is the string that must never reach
# stdout, stderr, the manifest or a sidecar.
make_stack() {
  local root=$1
  mkdir -p "$root/stack/opencode-config" \
    "$root/stack/disks/artifacts" \
    "$root/stack/disks/workspace/chats" \
    "$root/stack/disks/memory" \
    "$root/data/opencode-data/sessions" \
    "$root/stack/releases/20261118T120000Z"
  printf 'OPENCHAT_USER=owner\nSESSION_SECRET=SENTINEL_SECRET_VALUE\n' > "$root/stack/.env"
  chmod 600 "$root/stack/.env"
  printf '{"mcp":{}}\n' > "$root/stack/opencode-config/opencode.json"
  printf '# artifact\n' > "$root/stack/disks/artifacts/doc.md"
  printf 'hello chat\n' > "$root/stack/disks/workspace/chats/message.txt"
  printf '{"id":"f1"}\n' > "$root/stack/disks/memory/facts.jsonl"
  printf '{"session":1}\n' > "$root/data/opencode-data/sessions/s1.json"
  printf '2.2.0\n' > "$root/stack/releases/20261118T120000Z/tag"
  printf 'services: {}\n' > "$root/stack/releases/20261118T120000Z/compose.yaml"
  ln -sfn releases/20261118T120000Z "$root/stack/current"
}

backup_in() {
  bash "$BACKUP" --stack-dir "$1/stack" --out-dir "$1/out" \
    --opencode-data "$1/data/opencode-data" "${@:2}"
}

# A fake binary stub: stub PATH_DIR NAME BODY [SHEBANG]
stub_bin() {
  local dir=$1 name=$2 body=$3
  mkdir -p "$dir"
  printf '#!/bin/sh\n%s\n' "$body" > "$dir/$name"
  chmod +x "$dir/$name"
}
