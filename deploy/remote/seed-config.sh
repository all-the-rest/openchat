#!/usr/bin/env bash
#
# Seed the OpenCode MCP configuration once (issue #20).
#
# The artifact tool (`packages/artifact-tool`) runs as a stdio MCP server inside
# the OpenCode container and needs two values: where the BFF is and the shared
# bearer token. Both belong to the deployment, not to a person, so the deploy
# script writes them once into the config volume instead of asking the owner to
# hand-edit a file.
#
# `/opt/stacks/openchat/opencode-config/opencode.json` is created only when it
# does not exist. An existing file is left byte-for-byte alone: the agent may
# have added providers or models, and a deploy must not overwrite them.
#
# The file is mode 0644 on purpose. It lives in a root-owned stack directory
# and is bind-mounted into one container that runs as root (the official image
# sets no user); the token it carries authorizes `POST /internal/artifacts` on
# the BFF, which is reachable only from the compose `backend` network and is
# not published. Host-local users can read a 0644 file, which is why the stack
# directory itself stays root-owned 0755 and the token only works in-network.
#
# No value is printed: the script names the path and the number of entries.

set -euo pipefail

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
CONFIG_DIR=""
DRY_RUN=0

TOOL_DIR=/opt/artifact-tool/packages/artifact-tool
TOOL_COMMAND_TSX=/opt/artifact-tool/node_modules/.bin/tsx
TOOL_ENTRY=/opt/artifact-tool/packages/artifact-tool/src/index.ts
BFF_URL=http://bff:8787

usage() {
  cat <<'EOF'
Seed /opt/stacks/openchat/opencode-config/opencode.json once.

Usage:
  seed-config.sh [options]

Options:
  --stack-dir DIR   stack root (default: /opt/stacks/openchat)
  --dry-run         print the plan; write nothing
  --help

Creates the file only when absent. Never prints the token.
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) [ "$#" -ge 2 ] || die "$1 needs a value"; STACK_DIR=$2; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

env_value() {
  sed -n "s/^$1=//p" "$STACK_DIR/.env" | tail -n 1 | tr -d "'\""
}

main() {
  parse_args "$@"
  CONFIG_DIR=${CONFIG_DIR:-$STACK_DIR/opencode-config}
  local file="$CONFIG_DIR/opencode.json"

  if [ -f "$file" ]; then
    # Only the entry count, never the content.
    local entries
    entries=$(grep -c '"openchat"' "$file" 2>/dev/null || true)
    note "config: kept $file (openchat entries: ${entries:-0}); content not shown"
    return 0
  fi

  [ -r "$STACK_DIR/.env" ] || die "missing $STACK_DIR/.env; run env-bootstrap.sh first"
  local token
  token=$(env_value ARTIFACT_INTERNAL_TOKEN)
  [ -n "$token" ] || die "$STACK_DIR/.env has no ARTIFACT_INTERNAL_TOKEN"

  if [ "$DRY_RUN" -eq 1 ]; then
    note "would: write $file (0644) with one local MCP entry for $BFF_URL"
    return 0
  fi

  mkdir -p "$CONFIG_DIR"
  umask 022
  local tmp="$file.tmp"
  cat > "$tmp" <<JSON
{
  "mcp": {
    "openchat": {
      "type": "local",
      "command": ["$TOOL_COMMAND_TSX", "$TOOL_ENTRY"],
      "enabled": true,
      "environment": {
        "OPENCHAT_BFF_URL": "$BFF_URL",
        "ARTIFACT_INTERNAL_TOKEN": "$token"
      }
    }
  }
}
JSON
  chmod 644 "$tmp"
  mv "$tmp" "$file"

  note "config: wrote $file (0644, one local MCP entry for $BFF_URL); token not shown"
  note "config: tool = $TOOL_DIR; re-check after an OpenCode config-schema upgrade"
}

main "$@"
