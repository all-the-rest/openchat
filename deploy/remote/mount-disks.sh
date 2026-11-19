#!/usr/bin/env bash
#
# Size-capped storage for the OpenChat stack (issue #20).
#
# The host's `/` is XFS with `noquota` and Docker 29 uses the containerd
# snapshotter, so per-container `storage_opt.size` is unavailable. A loopback
# ext4 image mounted at a host directory is the one hard cap that works: the
# filesystem returns ENOSPC at its size, and the bytes cannot grow the host
# volume further.
#
#   disks/artifacts.img  2 GiB  ->  disks/artifacts   bff (rw), artifact-host (ro)
#   disks/workspace.img  4 GiB  ->  disks/workspace   opencode, toolbox, bff (ro)
#   disks/dind.img       4 GiB  ->  disks/dind        dind rootless storage
#   disks/memory.img     1 GiB  ->  disks/memory      bff (rw) — agent memory store
#   disks/opencode-data.img 512 MiB -> disks/opencode-data  opencode (rw) — issue #43
#
# The images are created once (`truncate` + `mkfs.ext4`) and then only mounted.
# Rerunning is a no-op; `--umount` detaches them and refuses while an OpenChat
# container is running.
#
# The OpenCode image starts empty. OpenCode's state used to live in the
# `<project>_opencode-data` named volume, which is unbounded and sits on the root
# filesystem (issue #43, finding 7); deploy/remote/migrate-opencode-data.sh
# copies that volume into this image once. Run it before the first deploy that
# mounts the disk, or OpenCode starts on an empty data directory (recoverable:
# the volume keeps the original bytes and the migration adopts an empty disk).
#
# Ownership: a bind mount from the root of a fresh ext4 image is root:root 0755,
# unlike a named volume, which inherits the mode of the directory baked into the
# image. The BFF, the artifact host and the tools image run as uid/gid 1000, and
# the rootless dind daemon is uid 1000 inside its container, so each mount root
# is chowned to that owner after mounting (not recursive: the root only). The
# OpenCode service runs as root, like the named volume it replaces, so its data
# disk keeps root:root (the mkfs default, repaired explicitly).
#
# Free space: before creating anything, the script requires the free space that
# remains *after* the missing images to be at least `--reserve` (default 10 GiB).
# That reserve is for the Docker image store, the build cache, logs and the
# predecessor stack that still runs beside this one. It never shrinks an
# existing image; changing a size is an owner decision (see the runbook).
#
# Run by deploy/remote/deploy.sh during a deploy and at boot by
# deploy/remote/openchat-disks.service; both use this one file.

set -euo pipefail

# Stable, parseable numbers: `df` and `awk` must not switch to a decimal comma.
export LC_ALL=C

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
ARTIFACTS_SIZE=2G
WORKSPACE_SIZE=4G
DIND_SIZE=4G
MEMORY_SIZE=1G
OPENCODE_DATA_SIZE=512M
RESERVE=10G
SIZE_FLAGS=""
UMOUNT=0
DRY_RUN=0
# The service processes that write here run as uid/gid 1000 (see the header).
DISK_OWNER=1000:1000
# The OpenCode service runs as root, so its data disk is root-owned.
OPENCODE_DATA_OWNER=0:0
# File the compose guard checks; it lives inside the image, so an empty host
# directory (failed mount) cannot satisfy it.
DISK_MARKER=.openchat-disk

usage() {
  cat <<'EOF'
Size-capped loopback storage for the OpenChat stack.

Usage:
  mount-disks.sh [options]

Options:
  --stack-dir DIR        stack root (default: /opt/stacks/openchat)
  --artifacts-size SIZE  artifacts image size (default: 2G)
  --workspace-size SIZE  workspace image size (default: 4G)
  --dind-size SIZE       dind image size (default: 4G)
  --memory-size SIZE     memory image size (default: 1G)
  --opencode-data-size SIZE
                         OpenCode state image size (default: 512M)
  --reserve SIZE         free space that must remain (default: 10G)
  --umount               unmount the images; refuses while the stack runs
  --dry-run              print the plan; create, mount and unmount nothing
  --help

# Sizes accept a K, M, G or T suffix (1024-based). The deploy script records the
# chosen sizes in disks/layout; a boot without flags reads that file first.
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

usage_error() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

note() {
  printf '%s\n' "$*"
}

plan() {
  printf 'would: %s\n' "$*"
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$*"
    return 0
  fi
  "$@"
}

require_value() {
  [ "$#" -ge 2 ] || { printf '%s: %s needs a value\n' "$PROG" "$1" >&2; exit 2; }
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --artifacts-size) require_value "$@"; ARTIFACTS_SIZE=$2; SIZE_FLAGS="$SIZE_FLAGS artifacts"; shift 2 ;;
      --workspace-size) require_value "$@"; WORKSPACE_SIZE=$2; SIZE_FLAGS="$SIZE_FLAGS workspace"; shift 2 ;;
      --dind-size) require_value "$@"; DIND_SIZE=$2; SIZE_FLAGS="$SIZE_FLAGS dind"; shift 2 ;;
      --memory-size) require_value "$@"; MEMORY_SIZE=$2; SIZE_FLAGS="$SIZE_FLAGS memory"; shift 2 ;;
      --opencode-data-size) require_value "$@"; OPENCODE_DATA_SIZE=$2; SIZE_FLAGS="$SIZE_FLAGS opencode-data"; shift 2 ;;
      --reserve) require_value "$@"; RESERVE=$2; SIZE_FLAGS="$SIZE_FLAGS reserve"; shift 2 ;;
      --umount) UMOUNT=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) printf '%s: unknown argument: %s\n' "$PROG" "$1" >&2; exit 2 ;;
    esac
  done
}

# The deploy script records the sizes it used so a boot-time run cannot drift
# from the images that already exist. An explicit flag wins over the file.
layout_value() {
  local key=$1 file="$STACK_DIR/disks/layout"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1 | tr -d "'\"[:space:]"
}

apply_layout() {
  local value
  case " $SIZE_FLAGS " in
    *" artifacts "*) ;;
    *) value=$(layout_value artifacts); [ -n "$value" ] && ARTIFACTS_SIZE=$value ;;
  esac
  case " $SIZE_FLAGS " in
    *" workspace "*) ;;
    *) value=$(layout_value workspace); [ -n "$value" ] && WORKSPACE_SIZE=$value ;;
  esac
  case " $SIZE_FLAGS " in
    *" dind "*) ;;
    *) value=$(layout_value dind); [ -n "$value" ] && DIND_SIZE=$value ;;
  esac
  # deploy.sh does not record this one yet; the default applies when absent.
  case " $SIZE_FLAGS " in
    *" memory "*) ;;
    *) value=$(layout_value memory); [ -n "$value" ] && MEMORY_SIZE=$value ;;
  esac
  # Issue #43: the OpenCode state disk. deploy.sh records it like the others.
  case " $SIZE_FLAGS " in
    *" opencode-data "*) ;;
    *) value=$(layout_value opencode-data); [ -n "$value" ] && OPENCODE_DATA_SIZE=$value ;;
  esac
  case " $SIZE_FLAGS " in
    *" reserve "*) ;;
    *) value=$(layout_value reserve); [ -n "$value" ] && RESERVE=$value ;;
  esac
  return 0
}

# 2G -> 2097152 KiB. Anything that is not a positive integer with a suffix is a
# usage error, not a guess. `validate_size` runs before any arithmetic so a bad
# value dies with a readable message instead of `missing_kib + : syntax error`.
validate_size() {
  local name=$1 value=$2 number
  case "$value" in
    *[KkMmGgTt]) number=${value%?} ;;
    *) usage_error "$name must be a number with a K/M/G/T suffix: $value" ;;
  esac
  case "$number" in
    ""|*[!0-9]*) usage_error "$name must be a number with a K/M/G/T suffix: $value" ;;
  esac
  [ "$number" -gt 0 ] || usage_error "$name must be positive: $value"
}

validate_sizes() {
  validate_size "--artifacts-size" "$ARTIFACTS_SIZE"
  validate_size "--workspace-size" "$WORKSPACE_SIZE"
  validate_size "--dind-size" "$DIND_SIZE"
  validate_size "--memory-size" "$MEMORY_SIZE"
  validate_size "--opencode-data-size" "$OPENCODE_DATA_SIZE"
  validate_size "--reserve" "$RESERVE"
}

to_kib() {
  local value=$1 number suffix
  case "$value" in
    *[Kk]) number=${value%?}; suffix=1 ;;
    *[Mm]) number=${value%?}; suffix=1024 ;;
    *[Gg]) number=${value%?}; suffix=1048576 ;;
    *[Tt]) number=${value%?}; suffix=1073741824 ;;
    *) number=$value; suffix=1 ;;
  esac
  case "$number" in
    ""|*[!0-9]*) die "invalid size: $value" ;;
  esac
  [ "$number" -gt 0 ] || die "size must be positive: $value"
  printf '%s' "$((number * suffix))"
}

gib() {
  # KiB -> one decimal GiB for humans; awk keeps it integer-safe.
  awk -v kib="$1" 'BEGIN { printf "%.1f GiB", kib / 1048576 }'
}

available_kib() {
  # Free space on the filesystem that holds the images, in KiB. In a dry run on
  # a host where the stack directory does not exist yet, `/` is the right
  # estimate: the stack lives under /opt.
  local probe=$STACK_DIR
  [ -d "$probe" ] || probe=/
  df -Pk "$probe" | awk 'NR==2 { print $4 }'
}

is_mounted() {
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q "$1"
  else
    # macOS/BSD have no `mountpoint`; `mount` prints "<dev> on <dir> (<type>…)".
    mount | grep -q " on $1 "
  fi
}

compose_running() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=openchat" 2>/dev/null)" ]
}

do_umount() {
  local name
  for name in artifacts workspace dind memory opencode-data; do
    local target="$STACK_DIR/disks/$name"
    if [ ! -d "$target" ] || ! is_mounted "$target"; then
      note "disk: $name is not mounted"
      continue
    fi
    if compose_running; then
      die "an OpenChat container is running; stop it before --umount (docker compose down)"
    fi
    # `sync` first: ext4 journalling makes the umount safe, and a dirty image is
    # still recoverable, but there is no reason to leave writes in flight.
    run sync
    run umount "$target"
    note "disk: unmounted $target"
  done
}

check_free_space() {
  local missing_kib=0 name
  for name in artifacts workspace dind memory opencode-data; do
    if [ ! -f "$STACK_DIR/disks/$name.img" ]; then
      case "$name" in
        artifacts) missing_kib=$((missing_kib + $(to_kib "$ARTIFACTS_SIZE"))) ;;
        workspace) missing_kib=$((missing_kib + $(to_kib "$WORKSPACE_SIZE"))) ;;
        dind) missing_kib=$((missing_kib + $(to_kib "$DIND_SIZE"))) ;;
        memory) missing_kib=$((missing_kib + $(to_kib "$MEMORY_SIZE"))) ;;
        opencode-data) missing_kib=$((missing_kib + $(to_kib "$OPENCODE_DATA_SIZE"))) ;;
      esac
    fi
  done

  local reserve_kib avail_kib
  reserve_kib=$(to_kib "$RESERVE")
  avail_kib=$(available_kib)
  [ -n "$avail_kib" ] || die "cannot read free space for $STACK_DIR"
  if [ $((avail_kib - missing_kib)) -lt "$reserve_kib" ]; then
    die "not enough disk: $(gib "$avail_kib") free, $(gib "$missing_kib") needed for new images, $(gib "$reserve_kib") reserve"
  fi
  note "disk: $(gib "$avail_kib") free, $(gib "$missing_kib") to allocate, $(gib "$reserve_kib") reserve"
}

ensure_disk() {
  local name=$1 size=$2 owner=${3:-$DISK_OWNER}
  local img="$STACK_DIR/disks/$1.img" target="$STACK_DIR/disks/$1"
  local tmp="$img.tmp"

  if [ ! -f "$img" ]; then
    note "disk: creating $img ($size)"
    run rm -f "$tmp"
    run truncate -s "$size" "$tmp"
    # -F: the image is a file, not a block device; -q: no mkfs chatter. mkfs
    # runs on the temp name, so a failed mkfs cannot leave a 0-byte `.img` that
    # the next run trusts and only fails on at `mount`.
    if ! run mkfs.ext4 -F -q -L "openchat-$name" "$tmp"; then
      run rm -f "$tmp"
      die "mkfs.ext4 failed for $tmp; removed it, nothing was mounted"
    fi
    run mv -f "$tmp" "$img"
  else
    note "disk: $img exists ($(du -h "$img" | awk '{ print $1 }'))"
  fi

  run mkdir -p "$target"
  if is_mounted "$target"; then
    note "disk: $target already mounted"
  else
    run mount -o loop "$img" "$target"
    note "disk: mounted $target"
  fi

  # Repair on every run: a bind mount from a fresh ext4 root is root:root, and
  # the services write as uid/gid 1000 (OpenCode as root: its own disk owner).
  run chown "$owner" "$target"
  mark_disk "$name" "$target"
}

# Chat working files are the one subtree the BFF writes (issue #25). The remote
# overlay mounts it into the BFF as a nested bind, so the directory has to exist
# and belong to the service uid before the container starts; otherwise the BFF
# (uid 1000) cannot create a session directory inside a root-owned mount point.
ensure_chat_files() {
  local target=$1
  run mkdir -p "$target"
  run chown "$DISK_OWNER" "$target"
}

# The memory store is a nested bind inside the read-only workspace bind
# (`disks/memory:/workspace/.memory` on top of `disks/workspace:/workspace:ro`).
# Docker cannot create that mountpoint inside a read-only bind, so it has to
# exist on the workspace disk before the BFF starts. The BFF image bakes
# `/workspace/.memory` as node:node 0700 (deploy/Dockerfile.bff), so the host
# directory mirrors that mode; only uid 1000 may traverse the store.
ensure_memory_mountpoint() {
  local target=$1
  run mkdir -p "$target"
  run chown "$DISK_OWNER" "$target"
  run chmod 700 "$target"
}

# The marker is written inside the mounted image. A dry run must not create it,
# so it does not go through `run` (whose redirection would still execute).
mark_disk() {
  local name=$1 target=$2
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "write $target/$DISK_MARKER"
    return 0
  fi
  printf '%s\n' "$name" > "$target/$DISK_MARKER"
}

main() {
  parse_args "$@"
  apply_layout
  STACK_DIR=$(cd "$STACK_DIR" 2>/dev/null && pwd -P) || die "stack directory not found: $STACK_DIR"
  validate_sizes
  run mkdir -p "$STACK_DIR/disks"

  if [ "$UMOUNT" -eq 1 ]; then
    do_umount
    [ "$DRY_RUN" -eq 1 ] && note "dry run: nothing was mounted or unmounted"
    return 0
  fi

  check_free_space
  ensure_disk artifacts "$ARTIFACTS_SIZE"
  ensure_disk workspace "$WORKSPACE_SIZE"
  ensure_chat_files "$STACK_DIR/disks/workspace/chats"
  ensure_memory_mountpoint "$STACK_DIR/disks/workspace/.memory"
  ensure_disk dind "$DIND_SIZE"
  ensure_disk memory "$MEMORY_SIZE"
  # OpenCode's own state (issue #43): the service runs as root, so the disk is
  # root-owned. An empty image is fine — the migration adopts it — but a deploy
  # before the migration starts OpenCode on an empty data directory, so say so.
  if [ ! -f "$STACK_DIR/disks/opencode-data.img" ]; then
    note "disk: opencode-data starts empty; run deploy/remote/migrate-opencode-data.sh --apply"
    note "disk: before this deploy if the <project>_opencode-data volume still holds sessions"
  fi
  ensure_disk opencode-data "$OPENCODE_DATA_SIZE" "$OPENCODE_DATA_OWNER"
  # A fresh ext4 root is 0755; the BFF image bakes 0700 into the named volume's
  # mount point, so the host bind must match it (issue #49, §6.1). Only the BFF's
  # uid (1000) may traverse the memory store.
  run chmod 700 "$STACK_DIR/disks/memory"
  [ "$DRY_RUN" -eq 1 ] && note "dry run: nothing was created or mounted"
  return 0
}

main "$@"
