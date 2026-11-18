#!/usr/bin/env bash
#
# Run every deploy/remote/test/*.test.sh. No docker, no network and no deployed
# stack: fixtures live in a temporary directory and host tools are stubs.
#
# Usage: bash deploy/remote/test/run.sh
# Called by `pnpm run deploy:test` and by CI's fast job.

# No -e on purpose: every file runs and the loop records the first failure.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
failed=0

for test_file in "$HERE"/*.test.sh; do
  printf '\n== %s\n' "$(basename "$test_file")"
  if ! bash "$test_file"; then
    failed=1
    printf 'FAILED: %s\n' "$(basename "$test_file")" >&2
  fi
done

if [ "$failed" -eq 0 ]; then
  printf '\ndeploy tests: ok\n'
  exit 0
fi
printf '\ndeploy tests: FAILED\n' >&2
exit 1
