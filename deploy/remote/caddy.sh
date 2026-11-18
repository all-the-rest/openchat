#!/usr/bin/env bash
#
# Install or remove the OpenChat site blocks in the host's Caddy container
# (issue #20). The container already terminates TLS for the host's other sites;
# this script never edits their blocks.
#
# The mechanism is additive and reversible:
#   1. stage the rendered fragment as `.openchat-stage/openchat.caddy`, beside a
#      copy of the host Caddyfile that carries `import openchat.caddy`
#   2. `caddy validate` that exact pair in the staging directory: imports
#      resolve relative to the importing file, so validation sees the same
#      names and bytes the live directory will have
#   3. only after a successful validate, move the fragment and then the
#      Caddyfile into place and reload. A broken fragment leaves both live files
#      byte-identical, so the next Caddy start (a reboot) still finds a valid
#      import.
#
# The first install keeps the original host Caddyfile as
# /etc/caddy/Caddyfile.openchat.bak and prints that path; later runs leave an
# existing backup alone. If `caddy reload` fails, the files on disk are the
# validated pair, so a restart comes up on them rather than on a broken config.
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
BACKUP=/etc/caddy/Caddyfile.openchat.bak
STAGE=/etc/caddy/.openchat-stage
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

The fragment is staged and validated as /etc/caddy/openchat.caddy before either
live file moves. `import openchat.caddy` is added to the existing Caddyfile
once; the first install keeps Caddyfile.openchat.bak. Validate precedes reload.
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
    plan "docker exec -i $CONTAINER sh -c 'rm -rf $STAGE && mkdir -p $STAGE && cat > $STAGE/openchat.caddy' < $FRAGMENT"
    plan "docker exec $CONTAINER sh -c '<keep $BACKUP once, copy Caddyfile to $STAGE, add $IMPORT_LINE, caddy validate the staged pair>'"
    plan "docker exec $CONTAINER sh -c '<move $STAGE/openchat.caddy to $TARGET, then $STAGE/Caddyfile to $CADDYFILE>'"
    plan "docker exec $CONTAINER caddy reload --config $CADDYFILE --adapter caddyfile"
    return 0
  fi

  docker exec -i "$CONTAINER" sh -c \
    "rm -rf $STAGE && mkdir -p $STAGE && cat > $STAGE/openchat.caddy" < "$FRAGMENT"

  # One shell, one staged pair. `import openchat.caddy` resolves beside the
  # staged Caddyfile, exactly as it will beside the live one.
  local script="
set -eu
cd /etc/caddy
stage=$STAGE
cleanup() { rm -rf \"\$stage\"; }
trap cleanup EXIT
if [ ! -f Caddyfile.openchat.bak ]; then
  cp Caddyfile Caddyfile.openchat.bak
  printf 'caddy: pre-install Caddyfile kept at /etc/caddy/Caddyfile.openchat.bak\n'
fi
cp Caddyfile \"\$stage/Caddyfile\"
grep -qxF '$IMPORT_LINE' \"\$stage/Caddyfile\" || printf '\n%s\n' '$IMPORT_LINE' >> \"\$stage/Caddyfile\"
caddy validate --config \"\$stage/Caddyfile\" --adapter caddyfile
mv \"\$stage/openchat.caddy\" openchat.caddy
mv \"\$stage/Caddyfile\" Caddyfile
"
  docker exec "$CONTAINER" sh -c "$script"
  docker exec "$CONTAINER" caddy reload --config "$CADDYFILE" --adapter caddyfile
  note "caddy: imported $TARGET and reloaded"
}

remove_fragment() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "docker exec $CONTAINER sh -c '<copy Caddyfile to $STAGE, drop $IMPORT_LINE, caddy validate>'"
    plan "docker exec $CONTAINER sh -c '<move $STAGE/Caddyfile to $CADDYFILE, then rm -f $TARGET>'"
    plan "docker exec $CONTAINER caddy reload --config $CADDYFILE --adapter caddyfile"
    return 0
  fi

  local script="
set -eu
cd /etc/caddy
stage=$STAGE
cleanup() { rm -rf \"\$stage\"; }
trap cleanup EXIT
mkdir -p \"\$stage\"
grep -vxF '$IMPORT_LINE' Caddyfile > \"\$stage/Caddyfile\" || true
caddy validate --config \"\$stage/Caddyfile\" --adapter caddyfile
mv \"\$stage/Caddyfile\" Caddyfile
rm -f openchat.caddy
"
  docker exec "$CONTAINER" sh -c "$script"
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
  if [ "$DRY_RUN" -eq 1 ]; then note "dry run: Caddy was not touched"; fi
}

main "$@"
