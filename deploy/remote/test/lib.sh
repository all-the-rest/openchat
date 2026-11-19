#!/usr/bin/env bash
# Shared assertions and fixtures for the deploy/remote shell tests (issue #9).
# Sourced by each *.test.sh; not a standalone command.

TEST_ROOT=${TEST_ROOT:-/tmp}
REMOTE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
REPO_ROOT=$(cd "$REMOTE_DIR/../.." && pwd -P)
BACKUP_SH=$REMOTE_DIR/backup.sh
STATUS_SH=$REMOTE_DIR/status.sh
SWAP_SH=$REPO_ROOT/deploy/swap.sh
DEPLOY_SH=$REMOTE_DIR/deploy.sh

fail() { printf '  FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf '  ok: %s\n' "$*"; }

assert_eq() {
  local desc=$1 actual=$2 expected=$3
  [ "$actual" = "$expected" ] || fail "$desc (got '$actual', want '$expected')"
  pass "$desc"
}

assert_contains() {
  local desc=$1 haystack=$2 needle=$3
  printf '%s' "$haystack" | grep -qF -- "$needle" || fail "$desc (missing '$needle')"
  pass "$desc"
}

assert_not_contains() {
  local desc=$1 haystack=$2 needle=$3
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then fail "$desc (found '$needle')"; fi
  pass "$desc"
}

assert_file() {
  [ -f "$1" ] || fail "$2 ($1 is not a file)"
  pass "$2"
}

assert_no_file() {
  [ ! -e "$1" ] || fail "$2 ($1 exists)"
  pass "$2"
}

assert_count() {
  local desc=$1 expected=$2 actual=$3
  [ "$actual" -eq "$expected" ] || fail "$desc (got $actual, want $expected)"
  pass "$desc"
}

# Paths, sizes and content hashes: a change anywhere under the root is caught.
fingerprint() {
  local root=$1 f
  find "$root" -print | LC_ALL=C sort
  while IFS= read -r f; do
    printf '%s  ' "${f#"$root"/}"
    shasum -a 256 "$f" 2>/dev/null | awk '{ print $1 }' ||
      sha256sum "$f" 2>/dev/null | awk '{ print $1 }'
  done < <(find "$root" -type f -print | LC_ALL=C sort)
}

# A representative stack: every backup target exists and is readable.
make_stack() {
  local root=$1
  mkdir -p "$root/opencode-config" "$root/disks/workspace/chats" \
    "$root/disks/artifacts" "$root/opencode-data"
  printf 'BFF_PORT=8787\nSECRET_MARKER=do-not-print\n' > "$root/.env"
  chmod 600 "$root/.env"
  printf '{"mcp":{}}\n' > "$root/opencode-config/opencode.json"
  chmod 600 "$root/opencode-config/opencode.json"
  printf 'chat data\n' > "$root/disks/workspace/chats/a.md"
  printf 'artifact\n' > "$root/disks/artifacts/doc.txt"
  printf 'session\n' > "$root/opencode-data/state.json"
}

new_case() {
  local name=$1
  local dir="$TEST_ROOT/$name"
  mkdir -p "$dir"
  printf '%s' "$dir"
}
