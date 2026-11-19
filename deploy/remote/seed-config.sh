#!/usr/bin/env bash
#
# Seed the OpenCode MCP configuration once (issue #20). The artifact, python and
# memory tools (`packages/*-tool`) run as stdio MCP servers inside the OpenCode
# container and need the BFF URL plus their shared bearer tokens, which belong to
# the deployment, so this script writes them into the config volume.
#
# `/opt/stacks/openchat/opencode-config/opencode.json` is created when absent.
# When present, only `mcp.openchat-memory` is added or, after a token rotation,
# replaced as one block; every other byte survives (issue #49). The mode is
# repaired to 0600 on every run, and the merged document is parsed before it
# replaces the original: an invalid result leaves the file byte-for-byte in place.
#
# The file is 0600 in one root container, so other host users cannot read the
# tokens for the BFF's `POST /internal/*` routes (compose `backend` only). No
# value is printed: the script names the path and the entry count.

set -euo pipefail

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
CONFIG_DIR=""
DRY_RUN=0

TOOL_DIR=/opt/artifact-tool/packages/artifact-tool
TOOL_COMMAND_TSX=/opt/artifact-tool/node_modules/.bin/tsx
TOOL_ENTRY=/opt/artifact-tool/packages/artifact-tool/src/index.ts
PYTHON_TOOL_ENTRY=/opt/artifact-tool/packages/python-tool/src/index.ts
MEMORY_TOOL_ENTRY=/opt/artifact-tool/packages/memory-tool/src/index.ts
PYTHON_BIN=/usr/bin/python3
BFF_URL=http://bff:8787
DOCUMENTS_URL=http://documents:8099
WORKSPACE=/workspace

usage() {
  cat <<'EOF'
Seed /opt/stacks/openchat/opencode-config/opencode.json once.

Usage:
  seed-config.sh [options]

Options:
  --stack-dir DIR   stack root (default: /opt/stacks/openchat)
  --dry-run         print the plan; write nothing
  --help

Creates the file when absent; an existing file gains or refreshes
mcp.openchat-memory only. Never prints a token.
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

# The memory entry in a 0600 temp file: the token never becomes an awk argument
# and never reaches stdout. Inner lines keep the seeded indent.
memory_entry_snippet() {
  local out=$1
  umask 077
  cat > "$out" <<JSON
"openchat-memory": {
      "type": "local",
      "command": ["$TOOL_COMMAND_TSX", "$MEMORY_TOOL_ENTRY"],
      "enabled": true,
      "environment": {
        "OPENCHAT_BFF_URL": "$BFF_URL",
        "MEMORY_INTERNAL_TOKEN": "$memory_token"
      }
    }
JSON
}

# Merges one key into the JSON object that already owns `mcp`, leaving every
# other byte untouched. If `openchat-memory` has a different token or BFF URL, its
# key and value are replaced as one block, so a rotation never leaves a stale
# entry. Exit 0 changed, 10 matches, other parse failure; the scan is quote-aware.
merge_memory_entry() {
  local file=$1 snippet=$2
  awk -v file="$file" -v snippetfile="$snippet" '
    function skip_ws(s, n, i) {
      while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
      return i
    }
    # Skips a quoted string starting at i; returns the position after it.
    function skip_string(s, n, i,   c) {
      i++
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\\") { i += 2; continue }
        if (c == "\"") return i + 1
        i++
      }
      return i
    }
    # Returns the opening brace of the object that follows `key`, or 0.
    function find_key_object(s, n, key,   i, c, c2, j) {
      i = 1
      while (i <= n) {
        c = substr(s, i, 1); c2 = substr(s, i + 1, 1)
        if (substr(s, i, length(key)) == key) {
          j = skip_ws(s, n, i + length(key))
          if (substr(s, j, 1) == ":") {
            j = skip_ws(s, n, j + 1)
            if (substr(s, j, 1) == "{") { KEY_START = i; return j }
          }
        }
        if (c == "\"") { i = skip_string(s, n, i); continue }
        if (c == "/" && c2 == "/") {
          j = index(substr(s, i), "\n")
          if (j == 0) return 0
          i = i + j
          continue
        }
        if (c == "/" && c2 == "*") {
          j = index(substr(s, i + 2), "*/")
          if (j == 0) return 0
          i = i + j + 2
          continue
        }
        i++
      }
      return 0
    }
    # First `{` outside strings and comments: the root object.
    function find_root(s, n,   i, c, c2, j) {
      i = 1
      while (i <= n) {
        c = substr(s, i, 1); c2 = substr(s, i + 1, 1)
        if (c == "{") return i
        if (c == "\"") { i = skip_string(s, n, i); continue }
        if (c == "/" && c2 == "/") {
          j = index(substr(s, i), "\n")
          if (j == 0) return 0
          i = i + j
          continue
        }
        if (c == "/" && c2 == "*") {
          j = index(substr(s, i + 2), "*/")
          if (j == 0) return 0
          i = i + j + 2
          continue
        }
        i++
      }
      return 0
    }
    # Matching close for the object at `open`, or 0.
    function matching_brace(s, n, open,   i, c, c2, j, depth) {
      depth = 0
      i = open
      while (i <= n) {
        c = substr(s, i, 1); c2 = substr(s, i + 1, 1)
        if (c == "\"") { i = skip_string(s, n, i); continue }
        if (c == "/" && c2 == "/") {
          j = index(substr(s, i), "\n")
          if (j == 0) return 0
          i = i + j
          continue
        }
        if (c == "/" && c2 == "*") {
          j = index(substr(s, i + 2), "*/")
          if (j == 0) return 0
          i = i + j + 2
          continue
        }
        if (c == "{") depth++
        else if (c == "}") { depth--; if (depth == 0) return i }
        i++
      }
      return 0
    }
    # Insert with a comma unless the object is still empty.
    function insert_at(s, closing, block, indent,   k, sep) {
      k = closing - 1
      while (k > 0 && substr(s, k, 1) ~ /[ \t\r\n]/) k--
      sep = (substr(s, k, 1) == "{") ? "" : ","
      return substr(s, 1, k) sep "\n" indent block "\n  " substr(s, closing)
    }
    # Quoted value of `key` in from..to, or "". Compares only; never printed.
    function value_at(s, from, to, key,   i, j, k) {
      i = index(substr(s, from, to - from + 1), key)
      if (!i) return ""
      j = skip_ws(s, to, from + i - 1 + length(key))
      if (substr(s, j, 1) != ":") return ""
      j = skip_ws(s, to, j + 1)
      if (substr(s, j, 1) != "\"") return ""
      k = skip_string(s, to, j)
      return substr(s, j + 1, k - j - 2)
    }
    BEGIN {
      s = ""
      while ((getline line < file) > 0) s = s line "\n"
      close(file)
      snippet = ""
      while ((getline line < snippetfile) > 0) snippet = snippet line "\n"
      close(snippetfile)
      sub(/\n$/, "", snippet)
      n = length(s)
      open = find_key_object(s, n, "\"openchat-memory\"")
      if (open) {
        closing = matching_brace(s, n, open)
        if (!closing) exit 3
        key_start = KEY_START
        ct = value_at(s, open, closing, "\"MEMORY_INTERNAL_TOKEN\"")
        cu = value_at(s, open, closing, "\"OPENCHAT_BFF_URL\"")
        if (ct != "" && ct == value_at(snippet, 1, length(snippet), "\"MEMORY_INTERNAL_TOKEN\"") &&
            cu == value_at(snippet, 1, length(snippet), "\"OPENCHAT_BFF_URL\"")) exit 10
        printf "%s%s%s", substr(s, 1, key_start - 1), snippet, substr(s, closing + 1)
        exit 0
      }
      open = find_key_object(s, n, "\"mcp\"")
      if (open) {
        closing = matching_brace(s, n, open)
        if (!closing) exit 3
        printf "%s", insert_at(s, closing, snippet, "    ")
        exit 0
      }
      rootOpen = find_root(s, n)
      rootClose = rootOpen ? matching_brace(s, n, rootOpen) : 0
      if (!rootClose) exit 3
      printf "%s", insert_at(s, rootClose, "\"mcp\": {\n    " snippet "\n  }", "  ")
    }
  ' 
}

# Parses a candidate config before it replaces the live one: a textual merge must
# never overwrite the only working file with invalid JSON. python3 is tried first
# (the deploy target is Linux); node is the fallback this repo's tests use.
# Returns 127 when neither parser is available.
validate_json() {
  local file=$1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$file" \
      >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$file" \
      >/dev/null 2>&1 && return 0
    return 1
  fi
  return 127
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

    local entries entry_present=0 verb
    entries=$(grep -c '"openchat"' "$file" 2>/dev/null || true)
    grep -q '"openchat-memory"' "$file" 2>/dev/null && entry_present=1

    [ -r "$STACK_DIR/.env" ] || die "missing $STACK_DIR/.env; run env-bootstrap.sh first"
    local memory_token
    memory_token=$(env_value MEMORY_INTERNAL_TOKEN)
    [ -n "$memory_token" ] || die "$STACK_DIR/.env has no MEMORY_INTERNAL_TOKEN; add a 32+ character token and rerun"

    if [ "$DRY_RUN" -eq 1 ]; then
      if [ "$entry_present" -eq 1 ]; then verb=refresh; else verb=add; fi
      note "would: $verb mcp.openchat-memory in $file; other keys unchanged"
      return 0
    fi

    local snippet out merge_status
    snippet=$(mktemp "${TMPDIR:-/tmp}/openchat-memory-entry.XXXXXX")
    out=$(mktemp "${TMPDIR:-/tmp}/openchat-memory-config.XXXXXX")
    memory_entry_snippet "$snippet"
    merge_status=0
    merge_memory_entry "$file" "$snippet" > "$out" || merge_status=$?
    if [ "$merge_status" -eq 10 ]; then
      rm -f "$snippet" "$out"
      note "config: kept $file (openchat entries: ${entries:-0}); content not shown"
      return 0
    fi
    if [ "$merge_status" -ne 0 ]; then
      rm -f "$snippet" "$out"
      die "could not merge mcp.openchat-memory into $file; the file is unchanged"
    fi
    chmod 600 "$out"
    merge_status=0
    validate_json "$out" || merge_status=$?
    if [ "$merge_status" -ne 0 ]; then
      rm -f "$snippet" "$out"
      if [ "$merge_status" -eq 127 ]; then
        die "cannot validate the merged config (python3 or node is required); the file is unchanged: $file"
      fi
      die "merged config is not valid JSON; the file is unchanged: $file"
    fi
    mv "$out" "$file"
    rm -f "$snippet"
    if [ "$entry_present" -eq 1 ]; then verb=refreshed; else verb=added; fi
    note "config: $verb mcp.openchat-memory in $file (token/URL from .env; other keys unchanged; token not shown)"
    return 0
  fi

  [ -r "$STACK_DIR/.env" ] || die "missing $STACK_DIR/.env; run env-bootstrap.sh first"
  local token documents_token memory_token
  token=$(env_value ARTIFACT_INTERNAL_TOKEN)
  [ -n "$token" ] || die "$STACK_DIR/.env has no ARTIFACT_INTERNAL_TOKEN"
  documents_token=$(env_value DOCUMENTS_TOKEN)
  [ -n "$documents_token" ] || die "$STACK_DIR/.env has no DOCUMENTS_TOKEN"
  memory_token=$(env_value MEMORY_INTERNAL_TOKEN)
  [ -n "$memory_token" ] || die "$STACK_DIR/.env has no MEMORY_INTERNAL_TOKEN"

  if [ "$DRY_RUN" -eq 1 ]; then
    note "would: configure compaction auto=true buffer=35% keep.tokens=12000"
    note "would: write $file (0600) with local MCP entries for $BFF_URL"
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
    "openchat-python": {
      "type": "local",
      "command": ["$TOOL_COMMAND_TSX", "$PYTHON_TOOL_ENTRY"],
      "enabled": true,
      "environment": {
        "OPENCHAT_BFF_URL": "$BFF_URL",
        "ARTIFACT_INTERNAL_TOKEN": "$token",
        "OPENCHAT_PYTHON": "$PYTHON_BIN",
        "WORKSPACE_DIR": "$WORKSPACE",
        "DOCUMENTS_URL": "$DOCUMENTS_URL",
        "DOCUMENTS_TOKEN": "$documents_token"
      }
    },
    "openchat-memory": {
      "type": "local",
      "command": ["$TOOL_COMMAND_TSX", "$MEMORY_TOOL_ENTRY"],
      "enabled": true,
      "environment": {
        "OPENCHAT_BFF_URL": "$BFF_URL",
        "MEMORY_INTERNAL_TOKEN": "$memory_token"
      }
    }
  },
  "compaction": {
    "auto": true,
    "buffer": "35%",
    "keep": {
      "tokens": 12000
    }
  }
}
JSON
  chmod 600 "$tmp"
  mv "$tmp" "$file"

  note "config: wrote $file (0600, local MCP entries for $BFF_URL); token not shown"
  note "config: tools = $TOOL_DIR, $PYTHON_TOOL_ENTRY and $MEMORY_TOOL_ENTRY; re-check after an OpenCode config-schema upgrade"
}

main "$@"
