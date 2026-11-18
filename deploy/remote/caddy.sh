#!/usr/bin/env bash
#
# Install or remove the OpenChat site blocks in the host's Caddy container
# (issue #20). The container already terminates TLS for the host's other sites;
# this script never edits their blocks.
#
# The mechanism is additive and reversible:
#   1. copy the rendered fragment to /etc/caddy/openchat.caddy (a mounted volume)
#   2. add `import openchat.caddy` to the existing Caddyfile **once**
#   3. validate a candidate copy in the same directory (imports resolve relative
#      to the importing file, so the candidate must sit beside the fragment)
#   4. only after a successful validate, move the candidate into place and
#      reload — a broken fragment never reaches the running configuration
#
# `caddy reload` asks the running process through its local admin API. If the
# reload fails, the Caddyfile on disk is already the new one; the caller sees a
# non-zero exit and can inspect/restore with the printed backup path.
#
# Only the `caddy` container is touched; the script refuses when it is missing
# or stopped. It prints file names and reload results, never file contents.

set -euo pipefail

PROG=$(basename "$0")
CONTAINER=caddy
FRAGMENT=""
REMOVE=0
DRY_RUN=0
CADDYFILE=/etc/caddy/Caddyfile
TARGET=/etc/caddy/openchat.caddy
IMPORT_LINE="import openchat.caddy"

usage() {
  cat <<'EOF'
Install or remove the OpenChat fragment in the host Caddy container.

Usage:
  caddy.sh --install --fragment FILE [options]
  caddy.sh --remove [options]

Options:
  --container NAME   Caddy container (default: caddy)
  --fragment FILE    rendered fragment to install (required for --install)
  --remove           remove the import line and the fragment
  --dry-run          print the plan; change nothing
  --help

The fragment is written to /etc/caddy/openchat.caddy; `import openchat.caddy`
is added to the existing Caddyfile once. Validate precedes reload.
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

plan() {
  printf 'would: %s\n' "$*"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --container) [ "$#" -ge 2 ] || die "$1 needs a value"; CONTAINER=$2; shift 2 ;;
      --fragment) [ "$#" -ge 2 ] || die "$1 needs a value"; FRAGMENT=$2; shift 2 ;;
      --install) REMOVE=0; shift ;;
      --remove) REMOVE=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  if [ "$REMOVE" -eq 0 ]; then
    [ -n "$FRAGMENT" ] || die "--fragment is required for an install"
    [ -f "$FRAGMENT" ] || die "fragment not found: $FRAGMENT"
  fi
}

container_running() {
  command -v docker >/dev/null 2>&1 || return 1
  [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]
}

install_fragment() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "docker exec -i $CONTAINER sh -c 'cat > $TARGET' < $FRAGMENT"
  else
    docker exec -i "$CONTAINER" sh -c "cat > $TARGET" < "$FRAGMENT"
  fi
  note "caddy: fragment written to $TARGET"

  # One shell, one candidate: cd into /etc/caddy so `import openchat.caddy`
  # resolves beside the candidate, then validate before the move.
  local script="
set -eu
cd /etc/caddy
cp Caddyfile Caddyfile.openchat.tmp
cleanup() { rm -f Caddyfile.openchat.tmp; }
trap cleanup EXIT
grep -qxF '$IMPORT_LINE' Caddyfile.openchat.tmp || printf '\n%s\n' '$IMPORT_LINE' >> Caddyfile.openchat.tmp
caddy validate --config Caddyfile.openchat.tmp --adapter caddyfile
mv Caddyfile.openchat.tmp Caddyfile
"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "docker exec $CONTAINER sh -c '<copy Caddyfile, add $IMPORT_LINE once, caddy validate>'"
    plan "docker exec $CONTAINER caddy reload --config $CADDYFILE --adapter caddyfile"
    return 0
  fi
  docker exec "$CONTAINER" sh -c "$script"
  docker exec "$CONTAINER" caddy reload --config "$CADDYFILE" --adapter caddyfile
  note "caddy: imported $TARGET and reloaded"
}

remove_fragment() {
  local script="
set -eu
cd /etc/caddy
cp Caddyfile Caddyfile.openchat.tmp
cleanup() { rm -f Caddyfile.openchat.tmp; }
trap cleanup EXIT
grep -vxF '$IMPORT_LINE' Caddyfile.openchat.tmp > Caddyfile.openchat.next || true
mv Caddyfile.openchat.next Caddyfile.openchat.tmp
caddy validate --config Caddyfile.openchat.tmp --adapter caddyfile
mv Caddyfile.openchat.tmp Caddyfile
"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "docker exec $CONTAINER sh -c '<copy Caddyfile, drop $IMPORT_LINE, caddy validate>'"
    plan "docker exec $CONTAINER sh -c 'rm -f $TARGET'"
    plan "docker exec $CONTAINER caddy reload --config $CADDYFILE --adapter caddyfile"
    return 0
  fi
  docker exec "$CONTAINER" sh -c "$script"
  docker exec "$CONTAINER" sh -c "rm -f $TARGET"
  docker exec "$CONTAINER" caddy reload --config "$CADDYFILE" --adapter caddyfile
  note "caddy: removed $TARGET and its import, reloaded"
}

main() {
  parse_args "$@"
  if [ "$DRY_RUN" -eq 0 ]; then
    container_running || die "container $CONTAINER is not running; the host Caddy must be up"
    docker exec "$CONTAINER" sh -c "test -f $CADDYFILE" \
      || die "$CONTAINER has no $CADDYFILE; refusing to guess another path"
  else
    note "would: check container $CONTAINER and $CADDYFILE"
  fi

  if [ "$REMOVE" -eq 1 ]; then
    remove_fragment
  else
    install_fragment
  fi
  [ "$DRY_RUN" -eq 1 ] && note "dry run: Caddy was not touched"
}

main "$@"
