#!/usr/bin/env bash
#
# Behaviour of deploy/remote/status.sh against a temporary stack and fake
# docker/curl/df binaries: one line per signal, exit 0 when everything is up,
# exit 1 when any probe fails, no write anywhere, and --logs only tails failing
# containers.

set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ok() { printf 'ok - %s\n' "$*"; }

# Collapses the alignment padding printf uses, so assertions read as words.
flat() { printf '%s' "$1" | tr -s ' '; }

PS_FILE=""
INSPECT_FILE=""
DOCKER_LOG=""

# build_fixture ROOT: fake binaries, healthy container fixtures, stack dir.
build_fixture() {
  local root=$1 bin
  make_stack "$root"
  bin="$root/bin"
  mkdir -p "$bin" "$root/fixtures"
  PS_FILE="$root/fixtures/ps"
  INSPECT_FILE="$root/fixtures/inspect"
  DOCKER_LOG="$root/docker.log"
  : > "$DOCKER_LOG"

  cat > "$PS_FILE" <<'EOF'
openchat-artifact-host-1|artifact-host|running|Up 3 days (healthy)
openchat-bff-1|bff|running|Up 3 days (healthy)
openchat-code-host-1|code-host|running|Up 3 days (healthy)
openchat-documents-1|documents|running|Up 3 days (healthy)
openchat-opencode-1|opencode|running|Up 3 days (healthy)
EOF
  cat > "$INSPECT_FILE" <<'EOF'
/openchat-artifact-host-1|running|healthy|0
/openchat-bff-1|running|healthy|0
/openchat-code-host-1|running|healthy|0
/openchat-documents-1|running|healthy|0
/openchat-opencode-1|running|healthy|0
EOF

  stub_bin "$bin" docker '
printf "%s\n" "$*" >> "$DOCKER_LOG"
case "$1" in
  ps) cat "$FAKE_PS" ;;
  inspect) cat "$FAKE_INSPECT" ;;
  logs) printf "fixture log line\n" ;;
esac'
  stub_bin "$bin" curl '
body=${FAKE_BODY:-"{\"ok\":true,\"mode\":\"live\",\"version\":\"2.2.0\"}"}
printf "%s\n%s" "$body" "${FAKE_CODE:-200}"'
  stub_bin "$bin" df '
printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
printf "/dev/fake 1000000 200000 800000 %s /fake\n" "${FAKE_DF_PERCENT:-20}%"'
  printf 'MemTotal:        4000000 kB\nMemAvailable:    3000000 kB\n' > "$root/fixtures/meminfo"
}

status_in() {
  local root=$1
  shift
  env PATH="$root/bin:$PATH" FAKE_PS="$PS_FILE" FAKE_INSPECT="$INSPECT_FILE" \
    DOCKER_LOG="$DOCKER_LOG" \
    bash "$STATUS_SH" --stack-dir "$root/stack" --base-url http://127.0.0.1:8787 \
    --meminfo "$root/fixtures/meminfo" "$@"
}

test_all_up() {
  local root output signals before after; root=$(new_dir)
  build_fixture "$root"
  before=$(cd "$root/stack" && find . -exec ls -ld {} + | LC_ALL=C sort)
  run_capture status_in "$root"
  output=$OUTPUT
  [ "$RUN_STATUS" -eq 0 ] || fail "healthy stack exited $RUN_STATUS: $output"
  after=$(cd "$root/stack" && find . -exec ls -ld {} + | LC_ALL=C sort)
  assert_eq "$after" "$before" "stack tree after status"
  grep -q '^inspect ' "$DOCKER_LOG" || fail "status did not inspect containers"
  signals=$(printf '%s\n' "$output" | awk '{ print $1 }' | LC_ALL=C sort -u)
  for name in release containers uptime healthz restarts disk ram; do
    assert_contains "$signals" "$name" "signal list"
  done
  assert_eq "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" "7" "signal lines"
  assert_not_contains "$output" "FAIL" "healthy stack"
  ok "a healthy stack prints one line per signal, exits 0 and writes nothing"
}

test_healthz_down() {
  local root; root=$(new_dir)
  build_fixture "$root"
  run_capture env PATH="$root/bin:$PATH" FAKE_PS="$PS_FILE" FAKE_INSPECT="$INSPECT_FILE" \
    DOCKER_LOG="$DOCKER_LOG" FAKE_CODE=500 \
    bash "$STATUS_SH" --stack-dir "$root/stack" --base-url http://127.0.0.1:8787 \
    --meminfo "$root/fixtures/meminfo"
  [ "$RUN_STATUS" -eq 1 ] || fail "healthz 500 exited $RUN_STATUS: $OUTPUT"
  assert_contains "$(flat "$OUTPUT")" "healthz FAIL" "status output"
  ok "healthz 500 exits 1 and names the failing probe"
}

test_unhealthy_or_exited_container() {
  local root; root=$(new_dir)
  build_fixture "$root"
  sed -e 's#^/openchat-bff-1|running|healthy|0#/openchat-bff-1|exited|none|7#' \
    -e 's#^/openchat-code-host-1|running|healthy|0#/openchat-code-host-1|running|unhealthy|0#' \
    "$INSPECT_FILE" > "$INSPECT_FILE.tmp" && mv "$INSPECT_FILE.tmp" "$INSPECT_FILE"
  run_capture status_in "$root"
  [ "$RUN_STATUS" -eq 1 ] || fail "exited/unhealthy containers exited $RUN_STATUS: $OUTPUT"
  assert_contains "$(flat "$OUTPUT")" "containers FAIL" "status output"
  assert_contains "$(flat "$OUTPUT")" "not running: bff(exited)" "status output"
  assert_contains "$(flat "$OUTPUT")" "unhealthy: code-host" "status output"
  ok "an exited or unhealthy container fails the containers probe"
}

test_restart_count_threshold() {
  local root; root=$(new_dir)
  build_fixture "$root"
  sed 's#^/openchat-opencode-1|running|healthy|0#/openchat-opencode-1|running|healthy|9#' \
    "$INSPECT_FILE" > "$INSPECT_FILE.tmp" && mv "$INSPECT_FILE.tmp" "$INSPECT_FILE"
  run_capture status_in "$root"
  [ "$RUN_STATUS" -eq 1 ] || fail "9 restarts exited $RUN_STATUS: $OUTPUT"
  assert_contains "$(flat "$OUTPUT")" "restarts FAIL" "status output"
  assert_contains "$OUTPUT" "opencode(9)" "status output"
  ok "a container above --restart-max fails the restarts probe"
}

test_disk_and_ram_thresholds() {
  local root; root=$(new_dir)
  build_fixture "$root"
  printf 'MemTotal:        4000000 kB\nMemAvailable:    40000 kB\n' > "$root/fixtures/meminfo"
  run_capture env PATH="$root/bin:$PATH" FAKE_PS="$PS_FILE" FAKE_INSPECT="$INSPECT_FILE" \
    DOCKER_LOG="$DOCKER_LOG" FAKE_DF_PERCENT=96 \
    bash "$STATUS_SH" --stack-dir "$root/stack" --base-url http://127.0.0.1:8787 \
    --meminfo "$root/fixtures/meminfo"
  [ "$RUN_STATUS" -eq 1 ] || fail "96% disk / 1% RAM exited $RUN_STATUS: $OUTPUT"
  assert_contains "$(flat "$OUTPUT")" "disk FAIL" "status output"
  assert_contains "$(flat "$OUTPUT")" "ram FAIL" "status output"
  ok "disk and RAM above their thresholds fail"
}

test_logs_only_for_failing_containers() {
  local root; root=$(new_dir)
  build_fixture "$root"
  sed 's#^/openchat-bff-1|running|healthy|0#/openchat-bff-1|exited|none|1#' \
    "$INSPECT_FILE" > "$INSPECT_FILE.tmp" && mv "$INSPECT_FILE.tmp" "$INSPECT_FILE"
  run_capture status_in "$root" --logs 5
  [ "$RUN_STATUS" -eq 1 ] || fail "--logs on a failing container exited $RUN_STATUS"
  assert_contains "$(flat "$OUTPUT")" "logs warn tailing 5 line(s) from: openchat-bff-1" "status output"
  assert_contains "$OUTPUT" "fixture log line" "status output"
  ok "--logs tails only failing containers"
}

test_all_up
test_healthz_down
test_unhealthy_or_exited_container
test_restart_count_threshold
test_disk_and_ram_thresholds
test_logs_only_for_failing_containers
