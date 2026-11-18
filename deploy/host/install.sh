#!/bin/sh
#
# Install the OpenChat host guards (issue #36) on the VPS.
#
# The scripts run on the host, so they live in $STACK_DIR/bin, beside the
# deploy-installed mount-disks.sh and caddy.sh. The units are rendered from this
# directory with @STACK_DIR@ replaced by the stack root and installed to
# /etc/systemd/system, then the three timers are enabled.
#
# `--uninstall` stops and removes the timers and units and removes only the
# three guard scripts; it keeps the state file and every container untouched.
#
# Every path is quoted. The only unquoted loop over $UNITS/$TIMERS is over
# fixed, space-free names.
#
# There is deliberately no docker call in this script and no docker.service
# ordering in the units: installing or removing a guard must never stop or
# restart the host's Docker daemon.

set -eu

PROG=install.sh
STACK_DIR=/opt/stacks/openchat
UNIT_DIR=/etc/systemd/system
ACTION=install
DRY_RUN=0

SCRIPTS="ram-watchdog.sh dind-gc.sh artifact-usage.sh"
UNITS="openchat-ram-watchdog.service openchat-ram-watchdog.timer \
openchat-dind-gc.service openchat-dind-gc.timer \
openchat-artifact-usage.service openchat-artifact-usage.timer"
TIMERS="openchat-ram-watchdog.timer openchat-dind-gc.timer openchat-artifact-usage.timer"

SCRIPT_DIR=$(CDPATH='' cd -P "$(dirname "$0")" && pwd -P)

usage() {
  cat <<'EOF'
Install or remove the OpenChat host guards.

Usage:
  install.sh [options]
  install.sh --uninstall [options]

Options:
  --stack-dir DIR   stack root with bin/ and current/ (default: /opt/stacks/openchat)
  --unit-dir DIR    systemd unit directory (default: /etc/systemd/system)
  --uninstall       disable and remove the units; keep the data and the state file
  --dry-run         print every step; change nothing
  --help
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

note() { printf '%s\n' "$*"; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'would:'
    printf ' %s' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

require_value() {
  [ "$#" -ge 2 ] || die "$1 needs a value"
}

validate_dir() {
  name=$1
  value=$2
  case "$value" in
    /*) ;;
    *) die "$name must be an absolute path: $value" ;;
  esac
  case "$value" in
    *[[:cntrl:]]*) die "$name must not contain control characters" ;;
  esac
  case "/$value/" in
    */../*) die "$name must not contain a '..' segment: $value" ;;
  esac
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --unit-dir) require_value "$@"; UNIT_DIR=$2; shift 2 ;;
      --uninstall) ACTION=uninstall; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  validate_dir "--stack-dir" "$STACK_DIR"
  validate_dir "--unit-dir" "$UNIT_DIR"
}

# Replace @STACK_DIR@ without sed's replacement escaping: a stack path may
# contain `/`, `&` or a space, and this walk treats the path as a literal.
render_unit() {
  src=$1
  dest=$2
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'would: render %s -> %s\n' "$src" "$dest"
    return 0
  fi
  tmp=$dest.tmp.$$
  awk -v dir="$STACK_DIR" '
    {
      out = ""
      rest = $0
      while ((i = index(rest, "@STACK_DIR@")) > 0) {
        out = out substr(rest, 1, i - 1) dir
        rest = substr(rest, i + 11)
      }
      print out rest
    }
  ' "$src" > "$tmp"
  install -m 644 "$tmp" "$dest"
  rm -f "$tmp"
}

do_install() {
  file=
  for file in $SCRIPTS $UNITS; do
    [ -f "$SCRIPT_DIR/$file" ] || die "missing source file: $SCRIPT_DIR/$file"
  done

  run install -d -m 755 "$STACK_DIR/bin"
  for file in $SCRIPTS; do
    run install -m 755 "$SCRIPT_DIR/$file" "$STACK_DIR/bin/$file"
  done

  run install -d -m 755 "$UNIT_DIR"
  for file in $UNITS; do
    render_unit "$SCRIPT_DIR/$file" "$UNIT_DIR/$file"
  done

  run systemctl daemon-reload
  for file in $TIMERS; do
    run systemctl enable --now "$file"
  done

  note ""
  note "installed: $STACK_DIR/bin/{ram-watchdog,dind-gc,artifact-usage}.sh"
  note "installed: $UNIT_DIR/openchat-{ram-watchdog,dind-gc,artifact-usage}.{service,timer}"
  note "timers:    ram-watchdog every 60 s, dind-gc daily, artifact-usage hourly"
  note "state:     $STACK_DIR/ram-watchdog.state (created only when the guard stops opencode)"
}

do_uninstall() {
  for file in $TIMERS; do
    if [ "$DRY_RUN" -eq 1 ]; then
      run systemctl disable --now "$file"
    else
      systemctl disable --now "$file" >/dev/null 2>&1 || true
    fi
  done

  for file in $UNITS; do
    run rm -f "$UNIT_DIR/$file"
  done
  for file in $SCRIPTS; do
    run rm -f "$STACK_DIR/bin/$file"
  done

  if [ "$DRY_RUN" -eq 1 ]; then
    run systemctl daemon-reload
  else
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi

  note ""
  note "removed: the three timers, the six units and the three guard scripts."
  note "kept on purpose: $STACK_DIR/ram-watchdog.state (the last decision), $STACK_DIR/bin"
  note "keep the deploy-installed mount-disks.sh and caddy.sh, .env, disks/*.img and all"
  note "containers. No container was stopped; opencode keeps whatever state it had."
  note "The dind GC is not a docker.service dependency, so removing it changes no daemon."
}

main() {
  parse_args "$@"
  case "$ACTION" in
    install) do_install ;;
    uninstall) do_uninstall ;;
  esac
  if [ "$DRY_RUN" -eq 1 ]; then
    note "dry run: nothing was installed, enabled, disabled or removed"
  fi
}

main "$@"
