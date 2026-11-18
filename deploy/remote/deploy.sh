#!/usr/bin/env bash
#
# Deploy the OpenChat stack to the owner's VPS over SSH (issue #20).
#
# The driver; only the helper scripts under deploy/remote/ and deploy/swap.sh
# run on the target, from the synced release source tree. One run: sync, install
# the boot unit and mount the size-capped ext4 images (2/4/4 GiB), bootstrap .env
# once, seed the MCP entry once, build six images, render the release
# (`config --no-interpolate`, no secret in a file), validate and swap, and
# install the Caddy fragment last: a failed deploy never takes the existing
# sites down and no certificate is requested for a dead upstream.
#
# Every value in a remote command is validated and quoted (ssh-safe.sh). No
# secret is accepted as an argument or printed: secrets live only in the
# host-only .env, which compose reads through `--env-file`.

set -euo pipefail

PROG=$(basename "$0")
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)

HOST=root@reisinger.pictures
DOMAIN=reisinger.pictures
STACK_DIR=/opt/stacks/openchat
PREDECESSOR_ENV=/opt/stacks/dev-vm/.env
PROJECT=openchat
CADDY_CONTAINER=caddy

TAG=""
ACTION=deploy
WITH_DIND=0
WITH_GUARDS=0
DRY_RUN=0
EXPECT_VERSION=""
ARTIFACTS_SIZE=2G
WORKSPACE_SIZE=4G
DIND_SIZE=4G
RESERVE=10G
# MemAvailable the host must still have before the tool + dind profile starts.
# 5120 MiB = the dind-enabled limit sum (~3.9 GiB) plus ~1 GiB for the host and
# the predecessor stack. Below it the containers would start and then OOM.
DIND_MIN_AVAILABLE_MIB=5120

REQUIRED_FILES=(
  compose.yaml deploy/swap.sh
  deploy/Dockerfile.opencode deploy/Dockerfile.documents deploy/remote/compose.yaml
  deploy/remote/Caddyfile.openchat deploy/remote/mount-disks.sh
  deploy/remote/env-bootstrap.sh deploy/remote/env-value.sh
  deploy/remote/seed-config.sh deploy/remote/caddy.sh
  deploy/remote/backup.sh deploy/remote/status.sh
  deploy/remote/openchat-disks.service deploy/remote/openchat-guard.sh
  deploy/remote/openchat-guard.service deploy/remote/prune-releases.sh deploy/remote/ssh-safe.sh
  deploy/host/install.sh deploy/host/ram-watchdog.sh deploy/host/dind-gc.sh
  deploy/host/artifact-usage.sh
)

usage() {
  cat <<'EOF'
Deploy OpenChat to the owner's VPS over SSH.

Usage:
  deploy/remote/deploy.sh [options]
  deploy/remote/deploy.sh --dry-run | --unmount | --uninstall

Options:
  --host USER@HOST        SSH target (default: root@reisinger.pictures)
  --domain DOMAIN         base domain; origins become chat. code. artifacts.
  --stack-dir DIR         stack root on the host (default: /opt/stacks/openchat)
  --predecessor-env FILE  where AUTH_USER and AUTH_HASH live
  --tag TAG               image tag (default: short commit sha)
  --with-dind             start toolbox + dind, after a MemAvailable check
  --with-guards           install and enable the host guard timers (RAM, dind GC, artifacts)
  --expect-version V      fail the swap unless /healthz reports V
  --artifacts-size SIZE   artifacts image (default: 2G)
  --workspace-size SIZE   workspace image (default: 4G)
  --dind-size SIZE        dind image (default: 4G)
  --reserve SIZE          free space that must remain (default: 10G)
  --dry-run               print every step ('would: …'), change nothing
  --unmount               unmount the disk images; refuses while the stack runs
  --uninstall             remove the Caddy fragment and stop the stack
  --help
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

usage_error() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  printf 'Try %s --help\n' "$PROG" >&2
  exit 2
}

note() { printf '%s\n' "$*"; }

plan() { printf 'would: %s\n' "$*"; }

. "$ROOT/deploy/remote/ssh-safe.sh"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$(quote_cmd "$@")"
    return 0
  fi
  "$@"
}

# `ssh` joins its argv with spaces and the remote shell parses the result, so a
# command is always built as one quoted string. `--` keeps a hostile --host
# value from being read as an option such as -oProxyCommand.
remote() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "ssh -- $(shquote "$HOST") $1"
    return 0
  fi
  ssh -- "$HOST" "$1"
}

require_value() {
  [ "$#" -ge 2 ] || usage_error "$1 needs a value"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --host) require_value "$@"; HOST=$2; shift 2 ;;
      --domain) require_value "$@"; DOMAIN=$2; shift 2 ;;
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --predecessor-env) require_value "$@"; PREDECESSOR_ENV=$2; shift 2 ;;
      --tag) require_value "$@"; TAG=$2; shift 2 ;;
      --expect-version) require_value "$@"; EXPECT_VERSION=$2; shift 2 ;;
      --artifacts-size) require_value "$@"; ARTIFACTS_SIZE=$2; shift 2 ;;
      --workspace-size) require_value "$@"; WORKSPACE_SIZE=$2; shift 2 ;;
      --dind-size) require_value "$@"; DIND_SIZE=$2; shift 2 ;;
      --reserve) require_value "$@"; RESERVE=$2; shift 2 ;;
      --with-dind) WITH_DIND=1; shift ;;
      --with-guards) WITH_GUARDS=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --unmount) ACTION=unmount; shift ;;
      --uninstall) ACTION=uninstall; shift ;;
      --help) usage; exit 0 ;;
      *)
        case "$1" in
          *=*) usage_error "KEY=VALUE arguments are refused; secrets live in the host .env" ;;
        esac
        usage_error "unknown argument: $1"
        ;;
    esac
  done

  case "$DOMAIN" in
    ""|*[!a-z0-9.-]*) usage_error "--domain must be a bare DNS name (lowercase letters, digits, dots, dashes)" ;;
    -*|*.|*..*|*.-*) usage_error "--domain must be a bare DNS name: $DOMAIN" ;;
  esac
  if [ "$WITH_DIND" -eq 1 ] && [ "$ACTION" != "deploy" ]; then
    usage_error "--with-dind only applies to a deploy"
  fi
  if [ "$WITH_GUARDS" -eq 1 ] && [ "$ACTION" != "deploy" ]; then
    usage_error "--with-guards only applies to a deploy"
  fi
  validate_inputs
}

preflight_local() {
  local missing=0 file
  for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$ROOT/$file" ]; then
      printf '%s: missing %s\n' "$PROG" "$file" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || die "the deploy layer is incomplete; fix the files above first"

  if [ "$DRY_RUN" -eq 0 ]; then
    local tool
    for tool in ssh rsync; do
      command -v "$tool" >/dev/null 2>&1 || die "$tool is required on this machine"
    done
  fi
}

resolve_tag() {
  if [ -z "$TAG" ]; then
    command -v git >/dev/null 2>&1 || die "git is required to resolve the image tag (or pass --tag)"
    TAG=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null) || die "not a git checkout; pass --tag"
  fi
  case "$TAG" in
    ""|*[!A-Za-z0-9._-]*) die "invalid image tag: $TAG" ;;
  esac
}

profiles() {
  if [ "$WITH_DIND" -eq 1 ]; then
    printf 'opencode,tools,dind'
  else
    printf 'opencode'
  fi
}

# The one compose invocation shape every step uses. `config --no-interpolate`
# keeps `${…}` references instead of baking .env values into a release file.
# Every word is quoted because the result is one remote shell command line.
compose_remote() {
  local sub=$1
  shift
  quote_cmd env "OPENCHAT_TAG=$TAG" "COMPOSE_PROFILES=$(profiles)" docker compose \
    --project-name "$PROJECT" --env-file "$STACK_DIR/.env" \
    --file "$SRC/compose.yaml" --file "$SRC/deploy/remote/compose.yaml" "$sub" "$@"
}

remote_compose() {
  local command
  command=$(compose_remote "$@")
  remote "cd $(shquote "$SRC") && $command"
}

remote_script() {
  local path=$1
  shift
  local command
  command=$(quote_cmd bash "$path" "$@")
  remote "$command"
}

step() {
  printf '\n== %s\n' "$*"
}

sync_source() {
  step "source -> $SRC"
  remote "$(quote_cmd mkdir -p \
    "$STACK_DIR/src" "$STACK_DIR/releases" "$STACK_DIR/bin" \
    "$STACK_DIR/disks" "$STACK_DIR/opencode-config")"
  run rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude '*/node_modules' \
    --exclude '*/dist' \
    --exclude .codegraph \
    --exclude references \
    --exclude 'apps/web/ui-review' \
    --exclude test-results \
    --exclude playwright-report \
    --exclude coverage \
    --exclude .env \
    --exclude '.env.*' \
    "$ROOT/" "$HOST:$SRC/"
}

install_boot_unit() {
  step "boot unit and disk layout"
  remote "$(quote_cmd install -m 755 "$SRC/deploy/remote/mount-disks.sh" "$STACK_DIR/bin/mount-disks.sh")"
  remote "$(quote_cmd install -m 755 "$SRC/deploy/remote/caddy.sh" "$STACK_DIR/bin/caddy.sh")"
  remote "$(quote_cmd install -m 755 "$SRC/deploy/remote/openchat-guard.sh" "$STACK_DIR/bin/openchat-guard.sh")"
  remote "$(quote_cmd install -m 755 "$SRC/deploy/remote/backup.sh" "$STACK_DIR/bin/backup.sh")"
  remote "$(quote_cmd install -m 755 "$SRC/deploy/remote/status.sh" "$STACK_DIR/bin/status.sh")"
  remote "$(quote_cmd install -m 644 "$SRC/deploy/remote/openchat-disks.service" /etc/systemd/system/openchat-disks.service)"
  remote "$(quote_cmd install -m 644 "$SRC/deploy/remote/openchat-guard.service" /etc/systemd/system/openchat-guard.service)"
  remote "systemctl daemon-reload && systemctl enable openchat-disks.service openchat-guard.service"
  remote "printf 'artifacts=%s\nworkspace=%s\ndind=%s\nreserve=%s\n' $(shquote "$ARTIFACTS_SIZE") $(shquote "$WORKSPACE_SIZE") $(shquote "$DIND_SIZE") $(shquote "$RESERVE") > $(shquote "$STACK_DIR/disks/layout")"
}

mount_disks() {
  step "size-capped disks"
  remote_script "$SRC/deploy/remote/mount-disks.sh" \
    --stack-dir "$STACK_DIR" \
    --artifacts-size "$ARTIFACTS_SIZE" \
    --workspace-size "$WORKSPACE_SIZE" \
    --dind-size "$DIND_SIZE" \
    --reserve "$RESERVE"
}

bootstrap_env() {
  step "host-only .env (create once, never overwrite)"
  remote_script "$SRC/deploy/remote/env-bootstrap.sh" \
    --stack-dir "$STACK_DIR" \
    --predecessor-env "$PREDECESSOR_ENV" \
    --domain "$DOMAIN"
}

seed_opencode_config() {
  step "OpenCode MCP config (create once)"
  remote_script "$SRC/deploy/remote/seed-config.sh" --stack-dir "$STACK_DIR"
}

check_dind_headroom() {
  [ "$WITH_DIND" -eq 1 ] || return 0
  step "dind memory precondition"
  local probe="awk '/^MemAvailable:/ { print \$2 }' /proc/meminfo"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "ssh -- $(shquote "$HOST") $(shquote "$probe") # require >= $DIND_MIN_AVAILABLE_MIB MiB"
    return 0
  fi
  local available
  available=$(ssh -- "$HOST" "$probe" 2>/dev/null || true)
  case "$available" in
    ""|*[!0-9]*) die "cannot read MemAvailable from $HOST" ;;
  esac
  if [ "$available" -lt "$DIND_MIN_AVAILABLE_MIB" ]; then
    die "only ${available} MiB MemAvailable; --with-dind needs ${DIND_MIN_AVAILABLE_MIB} MiB (stop the predecessor stack or drop --with-dind)"
  fi
  note "memory: ${available} MiB available, ${DIND_MIN_AVAILABLE_MIB} MiB required for dind"
}

build_images() {
  step "build images on the host"
  # `toolbox` (663 MB) is the dind tool runtime; no profile, no build.
  local services="bff code-host artifact-host documents opencode"
  [ "$WITH_DIND" -eq 1 ] && services="$services toolbox"
  remote_compose build $services
}

render_release() {
  step "render $RELEASE"
  local compose_file="$RELEASE/compose.yaml"
  local render
  render="set -eu; mkdir -p $(shquote "$RELEASE"); \
cd $(shquote "$SRC"); \
$(quote_cmd env "OPENCHAT_TAG=$TAG" COMPOSE_PROFILES=opencode,tools,dind docker compose \
  --project-name "$PROJECT" --env-file "$STACK_DIR/.env" \
  --file "$SRC/compose.yaml" --file "$SRC/deploy/remote/compose.yaml" \
  config --no-interpolate) > $(shquote "$compose_file"); \
chmod 600 $(shquote "$compose_file"); \
sed $(shquote "s/__OPENCHAT_DOMAIN__/$DOMAIN/g") $(shquote "$SRC/deploy/remote/Caddyfile.openchat") > $(shquote "$RELEASE/caddy.openchat"); \
chmod 644 $(shquote "$RELEASE/caddy.openchat"); \
printf '%s\n' $(shquote "$TAG") > $(shquote "$RELEASE/tag"); chmod 644 $(shquote "$RELEASE/tag")"
  remote "$render"
}

swap_release() {
  step "validate and swap"
  local args
  args=$(quote_cmd bash "$SRC/deploy/swap.sh" --stack-dir "$STACK_DIR" --release "$RELEASE")
  if [ -n "$EXPECT_VERSION" ]; then
    args="$args $(quote_cmd --expect-version "$EXPECT_VERSION")"
  fi
  remote "cd $(shquote "$STACK_DIR") && env $(shquote "OPENCHAT_TAG=$TAG") $(shquote "COMPOSE_PROFILES=$(profiles)") $args"
}

install_caddy() {
  step "Caddy fragment"
  remote_script "$SRC/deploy/remote/caddy.sh" \
    --container "$CADDY_CONTAINER" \
    --fragment "$RELEASE/caddy.openchat"
}

# Host guards (issue #36) are opt-in: they stop or start the `opencode` service
# and prune inside dind, which is a host-level decision. Installed from the
# synced source tree so the unit templates sit next to the installer; a failure
# is a warning, because the swap and the Caddy fragment already happened.
install_guards() {
  [ "$WITH_GUARDS" -eq 1 ] || return 0
  step "host guard timers"
  if [ "$DRY_RUN" -eq 1 ]; then
    remote "sh $(shquote "$SRC/deploy/host/install.sh") --stack-dir $(shquote "$STACK_DIR")"
    return 0
  fi
  if remote "sh $(shquote "$SRC/deploy/host/install.sh") --stack-dir $(shquote "$STACK_DIR")"; then
    note "host guards installed and their timers enabled"
  else
    note "warning: host guard install failed; the deploy is unaffected"
  fi
}

# Bounded retention: keep current and previous; non-fatal, the swap already succeeded.
prune_releases() {
  step "bounded release retention"
  remote_script "$SRC/deploy/remote/prune-releases.sh" --stack-dir "$STACK_DIR" || note "warning: release prune failed; the deploy is unaffected"
}

# BuildKit grew ~5.4 GiB per deploy on this host (#44) and the builder is shared
# with the other stacks, so keep a 4 GiB working set instead of wiping it. A
# failed prune must not fail a deploy that already swapped.
prune_build_cache() {
  step "trim the shared build cache"
  if ! remote "docker builder prune -f --keep-storage 4GB"; then
    note "warning: build cache prune failed; the deploy is unaffected"
  fi
}

summarize() {
  note ""
  note "deployed: tag $TAG, release ${RELEASE#"$STACK_DIR"/}"
  note "origins:  https://chat.$DOMAIN  https://code.$DOMAIN  https://artifacts.$DOMAIN"
  note "rollback: rerun swap.sh with the release named by readlink $STACK_DIR/previous"
  note "logs:     ssh $HOST 'docker compose -p $PROJECT logs --tail 100'"
}

do_deploy() {
  preflight_local
  resolve_tag
  SRC=$STACK_DIR/src/$TAG
  RELEASE=$STACK_DIR/releases/$(date -u +%Y%m%dT%H%M%SZ)

  note "host:     $HOST"
  note "source:   $SRC"
  note "release:  ${RELEASE#"$STACK_DIR"/}"
  note "tag:      $TAG"
  note "profiles: $(profiles)"

  sync_source
  install_boot_unit
  mount_disks
  bootstrap_env
  seed_opencode_config
  check_dind_headroom
  build_images
  render_release
  swap_release
  install_caddy
  install_guards
  prune_releases
  prune_build_cache
  summarize

  [ "$DRY_RUN" -eq 1 ] && note "dry run: nothing was synced, built, started, mounted or reloaded"
  return 0
}

do_unmount() {
  preflight_local
  step "unmount disks"
  remote_script "$STACK_DIR/bin/mount-disks.sh" --stack-dir "$STACK_DIR" --umount
  [ "$DRY_RUN" -eq 1 ] && note "dry run: nothing was unmounted"
  return 0
}

do_uninstall() {
  preflight_local
  step "remove the Caddy fragment"
  remote_script "$STACK_DIR/bin/caddy.sh" --container "$CADDY_CONTAINER" --remove
  step "stop the stack"
  remote "if [ -f $(shquote "$STACK_DIR/current/compose.yaml") ]; then cd $(shquote "$STACK_DIR") && docker compose --project-name $(shquote "$PROJECT") --env-file $(shquote "$STACK_DIR/.env") --file current/compose.yaml down; fi"
  step "remove the boot unit, the guard timers and installed helpers"
  remote "systemctl disable --now openchat-disks.service openchat-guard.service openchat-ram-watchdog.timer openchat-artifact-usage.timer openchat-dind-gc.timer 2>/dev/null || true; rm -f /etc/systemd/system/openchat-disks.service /etc/systemd/system/openchat-guard.service /etc/systemd/system/openchat-ram-watchdog.service /etc/systemd/system/openchat-ram-watchdog.timer /etc/systemd/system/openchat-dind-gc.service /etc/systemd/system/openchat-dind-gc.timer /etc/systemd/system/openchat-artifact-usage.service /etc/systemd/system/openchat-artifact-usage.timer; systemctl daemon-reload; rm -rf $(shquote "$STACK_DIR/bin")"
  note ""
  note "removed: the Caddy fragment and its import, the containers, openchat-disks.service, openchat-guard.service, the three guard timers and $STACK_DIR/bin."
  note "kept on purpose: $STACK_DIR/.env, $STACK_DIR/disks/*.img, $STACK_DIR/ram-watchdog.state and the Caddy backup - they hold data."
  note "a deploy reinstalls the unit and bin; unmount a kept image with the repo's mount-disks.sh --umount."
  [ "$DRY_RUN" -eq 1 ] && note "dry run: nothing was removed or stopped"
  return 0
}

main() {
  parse_args "$@"
  case "$ACTION" in
    deploy) do_deploy ;;
    unmount) do_unmount ;;
    uninstall) do_uninstall ;;
  esac
}

main "$@"
