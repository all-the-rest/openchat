#!/usr/bin/env bash
#
# Behaviour of deploy/remote/seed-config.sh: a fresh stack seeds all three MCP
# entries, an existing pre-memory file gains exactly mcp.openchat-memory and
# keeps every other byte, a fully seeded file is not rewritten, and no token
# ever reaches stdout or stderr.

set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ok() { printf 'ok - %s\n' "$*"; }

SEED="$REPO_ROOT/deploy/remote/seed-config.sh"
ARTIFACT_TOKEN="SENTINEL_ARTIFACT_TOKEN_VALUE"
DOCUMENTS_TOKEN="SENTINEL_DOCUMENTS_TOKEN_VALUE"
MEMORY_TOKEN="SENTINEL_MEMORY_TOKEN_VALUE"

build_stack() {
  local root=$1
  mkdir -p "$root/stack/opencode-config"
  printf 'ARTIFACT_INTERNAL_TOKEN=%s\nDOCUMENTS_TOKEN=%s\nMEMORY_INTERNAL_TOKEN=%s\n' \
    "$ARTIFACT_TOKEN" "$DOCUMENTS_TOKEN" "$MEMORY_TOKEN" > "$root/stack/.env"
  chmod 600 "$root/stack/.env"
}

seed_in() {
  local root=$1
  shift
  bash "$SEED" --stack-dir "$root/stack" "$@"
}

file_mode() {
  if stat -c %a "$1" >/dev/null 2>&1; then
    stat -c %a "$1"
  else
    stat -f %Lp "$1"
  fi
}

# Reads one dotted path from a JSON file; non-zero when it is absent.
json_field() {
  node -e '
    const fs = require("node:fs")
    const value = process.argv[2].split(".").reduce((node, key) => node?.[key], JSON.parse(fs.readFileSync(process.argv[1], "utf8")))
    if (value === undefined) process.exit(1)
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value))
  ' "$1" "$2"
}

assert_no_secret() {
  local output=$1
  for secret in "$ARTIFACT_TOKEN" "$DOCUMENTS_TOKEN" "$MEMORY_TOKEN"; do
    assert_not_contains "$output" "$secret" "seed output"
  done
}

test_fresh_file_seeds_every_entry() {
  local root file; root=$(new_dir)
  build_stack "$root"
  file="$root/stack/opencode-config/opencode.json"

  run_capture seed_in "$root"
  [ "$RUN_STATUS" -eq 0 ] || fail "fresh seed exited $RUN_STATUS: $OUTPUT"
  assert_file "$file"
  assert_eq "$(file_mode "$file")" "600" "config mode"
  for entry in openchat openchat-python openchat-memory; do
    assert_contains "$(cat "$file")" "\"$entry\"" "seeded config"
  done
  assert_eq "$(json_field "$file" mcp.openchat-memory.environment.MEMORY_INTERNAL_TOKEN)" "$MEMORY_TOKEN" "memory token"
  assert_eq "$(json_field "$file" mcp.openchat-memory.command.1)" \
    "/opt/artifact-tool/packages/memory-tool/src/index.ts" "memory tool entry"
  assert_contains "$OUTPUT" "wrote $file" "fresh seed output"
  assert_no_secret "$OUTPUT"
  ok "a fresh stack seeds artifact, Python and memory entries at 0600"
}

test_existing_file_gains_only_the_memory_entry() {
  local root file before; root=$(new_dir)
  build_stack "$root"
  file="$root/stack/opencode-config/opencode.json"
  cat > "$file" <<'JSON'
{
  "mcp": {
    "openchat": {
      "type": "local",
      "command": ["/custom/bin/artifact", "keep-this-command"],
      "enabled": true,
      "environment": {
        "ARTIFACT_INTERNAL_TOKEN": "keep-existing-token"
      }
    },
    "user-entry": {
      "type": "remote",
      "url": "https://example.invalid/mcp"
    }
  },
  "provider":    { "custom": { "npm": "keep-me-exactly" } },
  "compaction": { "auto": false }
}
JSON
  chmod 600 "$file"
  before=$(sha256_of "$file")

  run_capture seed_in "$root"
  [ "$RUN_STATUS" -eq 0 ] || fail "upgrade seed exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "added mcp.openchat-memory to $file" "upgrade seed output"
  assert_no_secret "$OUTPUT"
  [ "$(sha256_of "$file")" != "$before" ] || fail "config should have changed"

  # The new entry is functional and carries the deployment token.
  assert_eq "$(json_field "$file" mcp.openchat-memory.environment.MEMORY_INTERNAL_TOKEN)" "$MEMORY_TOKEN" "added token"
  assert_eq "$(json_field "$file" mcp.openchat-memory.environment.OPENCHAT_BFF_URL)" "http://bff:8787" "added BFF URL"
  assert_eq "$(json_field "$file" mcp.openchat-memory.enabled)" "true" "added entry enabled"
  assert_eq "$(grep -c '"openchat-memory"' "$file")" "1" "memory entry count"

  # Every unrelated entry and the custom formatting kept their value/bytes.
  assert_eq "$(json_field "$file" mcp.openchat.command.1)" "keep-this-command" "existing command"
  assert_eq "$(json_field "$file" mcp.openchat.environment.ARTIFACT_INTERNAL_TOKEN)" "keep-existing-token" "existing token"
  assert_eq "$(json_field "$file" mcp.user-entry.url)" "https://example.invalid/mcp" "unrelated MCP entry"
  assert_eq "$(json_field "$file" provider.custom.npm)" "keep-me-exactly" "unrelated provider"
  assert_eq "$(json_field "$file" compaction.auto)" "false" "unrelated compaction"
  assert_contains "$(cat "$file")" '  "provider":    { "custom": { "npm": "keep-me-exactly" } },' "untouched formatting"
  ok "an existing pre-memory file gains exactly the memory entry"
}

test_existing_file_without_mcp_gains_the_entry_at_the_root() {
  local root file; root=$(new_dir)
  build_stack "$root"
  file="$root/stack/opencode-config/opencode.json"
  cat > "$file" <<'JSON'
{
  "provider": { "custom": { "npm": "keep-me-exactly" } },
  "compaction": { "auto": false }
}
JSON
  chmod 600 "$file"

  run_capture seed_in "$root"
  [ "$RUN_STATUS" -eq 0 ] || fail "no-mcp seed exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "added mcp.openchat-memory to $file" "no-mcp seed output"
  assert_no_secret "$OUTPUT"

  # The entry landed under a new root `mcp` object; the root object had no such
  # key and every existing value kept its bytes.
  assert_eq "$(json_field "$file" mcp.openchat-memory.enabled)" "true" "inserted entry enabled"
  assert_eq "$(json_field "$file" mcp.openchat-memory.environment.MEMORY_INTERNAL_TOKEN)" "$MEMORY_TOKEN" "inserted token"
  assert_eq "$(json_field "$file" provider.custom.npm)" "keep-me-exactly" "unrelated provider"
  assert_eq "$(json_field "$file" compaction.auto)" "false" "unrelated compaction"
  assert_contains "$(cat "$file")" '  "provider": { "custom": { "npm": "keep-me-exactly" } },' "untouched formatting"
  assert_eq "$(grep -c '"mcp"' "$file")" "1" "root mcp count"
  ok "a file without an mcp key gains the memory entry at the root"
}

test_invalid_merge_leaves_the_file_untouched() {
  local root file before; root=$(new_dir)
  build_stack "$root"
  file="$root/stack/opencode-config/opencode.json"
  # The dangling comma survives awk's textual merge but is not valid JSON; the
  # candidate must be rejected before it replaces the only working file.
  cat > "$file" <<'JSON'
{
  "mcp": {
    "openchat": {
      "type": "local",
    }
  }
}
JSON
  chmod 600 "$file"
  before=$(sha256_of "$file")

  run_capture seed_in "$root"
  [ "$RUN_STATUS" -ne 0 ] || fail "an invalid merge must fail"
  assert_contains "$OUTPUT" "merged config is not valid JSON" "invalid merge output"
  assert_contains "$OUTPUT" "the file is unchanged" "invalid merge output"
  assert_no_secret "$OUTPUT"
  assert_eq "$(sha256_of "$file")" "$before" "config bytes"
  ok "an invalid merge fails and leaves the original bytes in place"
}

test_fully_seeded_file_is_unchanged() {
  local root file seeded; root=$(new_dir)
  build_stack "$root"
  file="$root/stack/opencode-config/opencode.json"
  run_capture seed_in "$root"
  [ "$RUN_STATUS" -eq 0 ] || fail "initial seed exited $RUN_STATUS: $OUTPUT"
  seeded=$(sha256_of "$file")

  run_capture seed_in "$root"
  [ "$RUN_STATUS" -eq 0 ] || fail "second seed exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "kept $file" "second seed output"
  assert_not_contains "$OUTPUT" "added mcp.openchat-memory" "second seed output"
  assert_no_secret "$OUTPUT"
  assert_eq "$(sha256_of "$file")" "$seeded" "config bytes"
  ok "a fully seeded file is kept byte-for-byte"
}

test_dry_run_on_existing_file_writes_nothing() {
  local root file before; root=$(new_dir)
  build_stack "$root"
  file="$root/stack/opencode-config/opencode.json"
  printf '{\n  "mcp": {}\n}\n' > "$file"
  chmod 600 "$file"
  before=$(sha256_of "$file")

  run_capture seed_in "$root" --dry-run
  [ "$RUN_STATUS" -eq 0 ] || fail "dry run exited $RUN_STATUS: $OUTPUT"
  assert_contains "$OUTPUT" "would: add mcp.openchat-memory to $file" "dry run output"
  assert_no_secret "$OUTPUT"
  assert_eq "$(sha256_of "$file")" "$before" "config bytes"
  ok "a dry run prints the merge plan and writes nothing"
}

test_fresh_file_seeds_every_entry
test_existing_file_gains_only_the_memory_entry
test_existing_file_without_mcp_gains_the_entry_at_the_root
test_invalid_merge_leaves_the_file_untouched
test_fully_seeded_file_is_unchanged
test_dry_run_on_existing_file_writes_nothing
