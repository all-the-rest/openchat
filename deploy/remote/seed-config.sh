#!/usr/bin/env bash
#
# Seed the OpenCode MCP configuration once (issue #20).
#
# Two stdio MCP servers run inside the OpenCode container: the artifact tool
# (`packages/artifact-tool`) and the document tools (`packages/python-tool`).
# Both need the BFF URL and the shared bearer token, and the document tools also
# need the image's interpreter path. Those values belong to the deployment, not
# to a person, so the deploy script writes them once into the config volume
# instead of asking the owner to hand-edit a file.
#
# `/opt/stacks/openchat/opencode-config/opencode.json` is created only when it
# does not exist. An existing file is left byte-for-byte alone: the agent may
# have added providers or models, and a deploy must not overwrite them. Its mode
# is repaired to 0600 on every run, because an earlier release could have left a
# world-readable file in place and that would expose the bearer token forever.
#
# The file is mode 0600. It is bind-mounted into one container that runs as root
# (the official image sets no user), so the container can read it while host
# users other than root cannot. That removes the host-user exposure of the
# token: it authorizes `POST /internal/artifacts` on the BFF, which is reachable
# only from the compose `backend` network and is not published.
#
# No value is printed: the script names the path and the number of entries.

set -euo pipefail

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
CONFIG_DIR=""
DRY_RUN=0

TOOL_DIR=/opt/artifact-tool/packages/artifact-tool
DOCUMENT_DIR=/opt/artifact-tool/packages/python-tool
TOOL_COMMAND_TSX=/opt/artifact-tool/node_modules/.bin/tsx
TOOL_ENTRY=/opt/artifact-tool/packages/artifact-tool/src/index.ts
DOCUMENT_ENTRY=/opt/artifact-tool/packages/python-tool/src/index.ts
PYTHON=/usr/bin/python3
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

# GNU stat first (the deploy target), BSD stat as the fallback for a local run.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || true
}

main() {
  parse_args "$@"
  CONFIG_DIR=${CONFIG_DIR:-$STACK_DIR/opencode-config}
  local file="$CONFIG_DIR/opencode.json"

  if [ -f "$file" ]; then
    local mode
    mode=$(file_mode "$file")
    if [ "$DRY_RUN" -eq 0 ] && [ "$mode" != "600" ]; then
      chmod 600 "$file"
      note "config: repaired mode of $file (${mode:-unknown} -> 0600); content unchanged"
    fi

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
    note "would: write $file (0600) with two local MCP entries for $BFF_URL"
    return 0
  fi

  mkdir -p "$CONFIG_DIR"
  umask 077
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
    },
    "openchat-documents": {
      "type": "local",
      "command": ["$TOOL_COMMAND_TSX", "$DOCUMENT_ENTRY"],
      "enabled": true,
      "environment": {
        "OPENCHAT_BFF_URL": "$BFF_URL",
        "ARTIFACT_INTERNAL_TOKEN": "$token",
        "OPENCHAT_PYTHON": "$PYTHON"
      }
    }
  }
}
JSON
  chmod 600 "$tmp"
  mv "$tmp" "$file"

  note "config: wrote $file (0600, two local MCP entries for $BFF_URL); token not shown"
  note "config: tools = $TOOL_DIR, $DOCUMENT_DIR, python = $PYTHON; re-check after an OpenCode config-schema upgrade"
}

main "$@"
