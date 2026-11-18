#!/usr/bin/env bash
#
# Deploy the OpenChat stack to the owner's VPS over SSH (issue #20).
#
# This is the driver; nothing in it runs on the target except the helper scripts
# under deploy/remote/ and deploy/swap.sh, which are synced first and executed
# from the release's source tree.
#
# What one run does, in order: sync the source; install the boot-time disk unit
# and mount the size-capped ext4 images (2/4/4 GiB); bootstrap .env once from the
# predecessor and generated secrets; seed the OpenCode MCP entry once; build the
# five images and render the release (`config --no-interpolate`, no secret in a
# file); let `deploy/swap.sh` validate and swap; install the Caddy fragment. The
# proxy comes last on purpose: a failed deploy never takes the existing sites
# down and no certificate is requested for a dead upstream.
#
# No secret is accepted as an argument or printed. Secrets live only in the
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
  compose.yaml
  deploy/swap.sh
  deploy/Dockerfile.opencode
  deploy/remote/compose.yaml
  deploy/remote/Caddyfile.openchat
  deploy/remote/mount-disks.sh
  deploy/remote/env-bootstrap.sh
  deploy/remote/env-value.sh
  deploy/remote/seed-config.sh
  deploy/remote/caddy.sh
  deploy/remote/openchat-disks.service
)

usage() {
  cat <<'EOF'
Deploy OpenChat to the owner's VPS over SSH.

Usage:
  deploy/remote/deploy.sh [options]
  deploy/remote/deploy.sh --dry-run
  deploy/remote/deploy.sh --unmount
  deploy/remote/deploy.sh --uninstall

Options:
  --host USER@HOST        SSH target (default: root@reisinger.pictures)
  --domain DOMAIN         base domain; origins become chat./code./artifacts.
                          (default: reisinger.pictures)
  --stack-dir DIR         stack root on the host (default: /opt/stacks/openchat)
  --predecessor-env FILE  where AUTH_USER and AUTH_HASH live
                          (default: /opt/stacks/dev-vm/.env)
  --tag TAG               image tag (default: short commit sha)
  --with-dind             start toolbox + dind, after a MemAvailable check
  --expect-version V      fail the swap unless /healthz reports V
  --artifacts-size SIZE   artifacts image (default: 2G)
  --workspace-size SIZE   workspace image (default: 4G)
  --dind-size SIZE        dind image (default: 4G)
  --reserve SIZE          free space that must remain (default: 10G)
  --dry-run               print every step ('would: …'), change nothing
  --unmount               unmount the disk images; refuses while the stack runs
  --uninstall             remove the Caddy fragment and stop the stack
  --help

Secrets are never accepted as arguments: they are read from and written to the
host-only .env. Rotation is an owner action (docs/implementation/20-remote-deploy.md).
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

note() {
  printf '%s\n' "$*"
}

plan() {
  printf 'would: %s\n' "$*"
}

quote_cmd() {
  local out=""
  local word
  for word in "$@"; do
    out+="${out:+ }$(printf '%q' "$word")"
  done
  printf '%s' "$out"
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$(quote_cmd "$@")"
    return 0
  fi
  "$@"
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
    *[!a-z0-9.-]*) usage_error "--domain must be a bare DNS name (lowercase letters, digits, dots, dashes)" ;;
  esac
  if [ "$WITH_DIND" -eq 1 ] && [ "$ACTION" != "deploy" ]; then
    usage_error "--with-dind only applies to a deploy"
  fi
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
compose_remote() {
  local sub=$1
  shift
  printf 'env OPENCHAT_TAG=%s COMPOSE_PROFILES=%s docker compose --project-name %s --env-file %s --file %s --file %s %s %s' \
    "$TAG" "$(profiles)" "$PROJECT" "$STACK_DIR/.env" \
    "$SRC/compose.yaml" "$SRC/deploy/remote/compose.yaml" "$sub" "$*"
}

remote_compose() {
  local command
  command=$(compose_remote "$@")
  run ssh "$HOST" "cd $SRC && $command"
}

remote_script() {
  local path=$1
  shift
  run ssh "$HOST" bash "$path" "$@"
}

step() {
  printf '\n== %s\n' "$*"
}

sync_source() {
  step "source -> $SRC"
  run ssh "$HOST" "mkdir -p $STACK_DIR/src $STACK_DIR/releases $STACK_DIR/bin $STACK_DIR/disks $STACK_DIR/opencode-config"
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
  run ssh "$HOST" "install -m 755 $SRC/deploy/remote/mount-disks.sh $STACK_DIR/bin/mount-disks.sh"
  run ssh "$HOST" "install -m 755 $SRC/deploy/remote/caddy.sh $STACK_DIR/bin/caddy.sh"
  run ssh "$HOST" "install -m 644 $SRC/deploy/remote/openchat-disks.service /etc/systemd/system/openchat-disks.service"
  run ssh "$HOST" "systemctl daemon-reload && systemctl enable openchat-disks.service"
  run ssh "$HOST" "printf 'artifacts=%s\nworkspace=%s\ndind=%s\nreserve=%s\n' '$ARTIFACTS_SIZE' '$WORKSPACE_SIZE' '$DIND_SIZE' '$RESERVE' > $STACK_DIR/disks/layout"
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
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "ssh $HOST \"awk '/^MemAvailable:/ { print \$2 }' /proc/meminfo\" # require >= $DIND_MIN_AVAILABLE_MIB MiB"
    return 0
  fi
  local available
  available=$(ssh "$HOST" "awk '/^MemAvailable:/ { print \$2 }' /proc/meminfo" 2>/dev/null || true)
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
  remote_compose build bff code-host artifact-host opencode toolbox
}

render_release() {
  step "render $RELEASE"
  local render="set -eu; mkdir -p $RELEASE; \
cd $SRC; \
env OPENCHAT_TAG=$TAG COMPOSE_PROFILES=opencode,tools,dind docker compose \
  --project-name $PROJECT --env-file $STACK_DIR/.env \
  --file $SRC/compose.yaml --file $SRC/deploy/remote/compose.yaml \
  config --no-interpolate > $RELEASE/compose.yaml; \
chmod 600 $RELEASE/compose.yaml; \
sed 's/__OPENCHAT_DOMAIN__/$DOMAIN/g' $SRC/deploy/remote/Caddyfile.openchat > $RELEASE/caddy.openchat; \
chmod 644 $RELEASE/caddy.openchat"
  run ssh "$HOST" "$render"
}

swap_release() {
  step "validate and swap"
  local extra=""
  [ -n "$EXPECT_VERSION" ] && extra=" --expect-version $EXPECT_VERSION"
  run ssh "$HOST" "cd $STACK_DIR && env OPENCHAT_TAG=$TAG COMPOSE_PROFILES=$(profiles) bash $SRC/deploy/swap.sh --stack-dir $STACK_DIR --release $RELEASE$extra"
}

install_caddy() {
  step "Caddy fragment"
  remote_script "$SRC/deploy/remote/caddy.sh" \
    --container "$CADDY_CONTAINER" \
    --fragment "$RELEASE/caddy.openchat"
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
  run ssh "$HOST" "if [ -f $STACK_DIR/current/compose.yaml ]; then cd $STACK_DIR && docker compose --project-name $PROJECT --env-file $STACK_DIR/.env --file current/compose.yaml down; fi"
  note ""
  note "kept on purpose: $STACK_DIR/.env, $STACK_DIR/disks/*.img, the docker volumes and the images."
  note "remove them only after a backup restore test; see docs/implementation/20-remote-deploy.md."
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
