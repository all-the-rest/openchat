#!/usr/bin/env bash
#
# Move OpenCode's state off its unbounded named volume and onto a size-capped
# ext4 image (issue #43, finding 7).
#
# `<project>_opencode-data` (~26 MiB today) is the last directory of this stack
# that grows without a cap, and it lives on the host's root filesystem. Every
# other large directory (artifacts, workspace, dind, memory) is already a
# loopback ext4 image that deploy/remote/mount-disks.sh creates and mounts.
# This script performs the one copy mount-disks.sh cannot do by itself:
#
#   1. stop only the `opencode` service (never the stack),
#   2. create and format `disks/opencode-data.img` (sparse, 512 MiB default),
#   3. mount it on `disks/opencode-data`,
#   4. copy the volume into it with a throwaway container
#      (`docker run --rm -v <project>_opencode-data:/src:ro -v <mnt>:/dst`),
#      so the data is read through Docker and never through a host path,
#   5. unmount and keep the image. The named volume is never modified.
#
# The default is a dry run: it prints the plan and changes nothing. `--apply`
# copies once; a second run refuses, because the disk carries a migration stamp.
# `--rollback` detaches the image and renames it to `<image>.rollback-<stamp>`;
# it never deletes anything.
#
# Secret hygiene: only counts, sizes and ids are printed. The copy container's
# output is discarded, so not even a file name from a failing `cp` reaches the
# terminal, and no file content is read on the host.
#
# Leavings: the mount is detached after a successful run, so the image can be
# moved or backed up. `mount-disks.sh` mounts it again on the next deploy and on
# boot, and the overlay's `disks-ready` gate refuses to start the stack while it
# is not mounted.

set -euo pipefail

# Stable, parseable numbers: `df`, `du` and `awk` must not print a decimal comma.
export LC_ALL=C

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
IMAGE_MIB=512
PROJECT=openchat
SERVICE=opencode
DISK=opencode-data
# The source volume is "<compose project>_<volume name>".
VOLUME_REF="${PROJECT}_${DISK}"
# Same pinned stock image as the overlay's `disks-ready` gate (index digest), so
# the copy needs nothing from a registry that a review has not already seen and
# no tool inside the OpenCode image. BusyBox `cp -a` preserves modes, ownership
# and timestamps; the container runs as root, like the service it copies for.
COPY_IMAGE="alpine:3@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf"
# Written inside the image by mount-disks.sh; allowed on an adopted, empty disk.
DISK_MARKER=.openchat-disk
# Written inside the image after a successful copy. Its presence is what makes a
# second `--apply` refuse, so a rerun can never copy twice.
STAMP=.openchat-migrated

MODE=""
DRY_RUN=""
SCRIPT=""

usage() {
  cat <<'EOF'
Bound OpenCode's state (issue #43, finding 7): copy the
<project>_opencode-data volume into a size-capped ext4 image.

Usage:
  migrate-opencode-data.sh [options]          # dry run (default)
  migrate-opencode-data.sh --apply [options]
  migrate-opencode-data.sh --rollback [options]

Options:
  --stack-dir DIR    stack root (default: /opt/stacks/openchat)
  --image-mib N      image size in MiB (default: 512)
  --apply            stop the `opencode` service, create/mount the image, copy
                     the volume's contents once, unmount, keep the image
  --rollback         unmount, then rename the image to
                     <image>.rollback-<stamp>; never deletes data
  --dry-run          print the plan; change nothing (the default)
  --help

The default is a dry run. `--apply` and `--rollback` act; adding `--dry-run` to
either prints that plan instead. A second `--apply` refuses: the disk carries a
migration stamp, and the volume is only ever read.

Both actions need root: mounting a loopback image and copying the files of a
Docker volume are privileged. Nothing here reads or prints a file's contents;
output is counts, sizes, volume and image ids only.

Exit codes: 0 success (or a validated no-op), 1 failure, 2 usage error.
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

require_value() {
  [ "$#" -ge 2 ] || usage_error "$1 needs a value"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --image-mib) require_value "$@"; IMAGE_MIB=$2; shift 2 ;;
      --apply) MODE=apply; shift ;;
      --rollback) MODE=rollback; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done

  [ -n "$MODE" ] || MODE=apply
  if [ -z "$DRY_RUN" ]; then
    case "$MODE" in
      apply) DRY_RUN=1 ;;
      rollback) DRY_RUN=0 ;;
    esac
  fi
}

validate_inputs() {
  case "$STACK_DIR" in
    /*) ;;
    *) usage_error "--stack-dir must be an absolute path: $STACK_DIR" ;;
  esac
  case "$IMAGE_MIB" in
    ""|*[!0-9]*) usage_error "--image-mib must be a positive integer: $IMAGE_MIB" ;;
  esac
  [ "$IMAGE_MIB" -gt 0 ] || usage_error "--image-mib must be positive: $IMAGE_MIB"
}

resolve_paths() {
  [ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
  STACK_DIR=$(cd "$STACK_DIR" && pwd -P)
  DISKS=$STACK_DIR/disks
  IMG=$DISKS/$DISK.img
  MNT=$DISKS/$DISK
  STAMP_PATH=$MNT/$STAMP
  COMPOSE_FILE=$STACK_DIR/current/compose.yaml
  # Free space is measured on the filesystem that holds the image.
  PROBE_DIR=$DISKS
  [ -d "$PROBE_DIR" ] || PROBE_DIR=$STACK_DIR
  SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")
}

is_mounted() {
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q "$1"
  else
    # macOS/BSD have no `mountpoint`; `mount` prints "<dev> on <dir> (<type>…)".
    mount | grep -q " on $1 "
  fi
}

docker_available() {
  command -v docker >/dev/null 2>&1
}

# The volume is reachable only through the daemon, never as a host path.
volume_exists() {
  docker volume inspect --format '{{.Name}}' "$VOLUME_REF" >/dev/null 2>&1
}

# Reads counts only, through a read-only bind of the volume.
probe_volume() {
  local out
  if [ "$DRY_RUN" -eq 1 ] && ! docker_available; then
    VOLUME_FILES=unknown
    VOLUME_KIB=unknown
    plan "count the files and KiB of volume $VOLUME_REF (docker is not available here)"
    return 0
  fi
  if ! out=$(docker run --rm -v "$VOLUME_REF:/src:ro" "$COPY_IMAGE" \
      sh -c 'printf "%s %s\n" "$(find /src -type f | wc -l)" "$(du -sk /src | cut -f1)"' \
      2>/dev/null); then
    die "cannot read volume $VOLUME_REF through docker (output suppressed; run the same docker run by hand to see why)"
  fi
  VOLUME_FILES=$(printf '%s\n' "$out" | tail -n 1 | awk '{ print $1 }')
  VOLUME_KIB=$(printf '%s\n' "$out" | tail -n 1 | awk '{ print $2 }')
  case "$VOLUME_FILES$VOLUME_KIB" in
    *[!0-9]*) die "the read-only probe of $VOLUME_REF printed no counts; nothing was changed" ;;
  esac
  note "volume: $VOLUME_REF ($VOLUME_FILES files, $VOLUME_KIB KiB; read-only, names not read)"
}

# 8 MiB of ext4 metadata and slack on top of the volume's own bytes.
check_capacity() {
  local available need_kib
  case "$VOLUME_KIB" in
    unknown) plan "require about $IMAGE_MIB MiB of free space in $STACK_DIR"; return 0 ;;
  esac
  need_kib=$((VOLUME_KIB + 8192))
  [ "$need_kib" -le $((IMAGE_MIB * 1024)) ] ||
    die "volume needs $VOLUME_KIB KiB plus metadata, more than --image-mib $IMAGE_MIB; pass a larger --image-mib"
  available=$(df -Pk "$PROBE_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$available" in
    ""|*[!0-9]*) die "cannot read free space for $PROBE_DIR" ;;
  esac
  [ "$available" -ge "$need_kib" ] ||
    die "not enough disk: $available KiB free, $need_kib KiB needed for the copy"
  note "space: $available KiB free in $PROBE_DIR, about $need_kib KiB needed (image cap ${IMAGE_MIB} MiB)"
}

compose_stop() {
  note "service: stopping only the $SERVICE service"
  run_cmd docker compose --project-name "$PROJECT" \
    --env-file "$STACK_DIR/.env" --file "$COMPOSE_FILE" stop "$SERVICE"
}

create_image() {
  local tmp="$IMG.tmp"
  note "image: creating $IMG (${IMAGE_MIB} MiB, ext4)"
  run_cmd rm -f "$tmp"
  run_cmd truncate -s "${IMAGE_MIB}M" "$tmp"
  # -F: the image is a file; -q: no mkfs chatter. mkfs runs on the temp name so
  # a failure cannot leave a 0-byte `.img` that the next run trusts.
  if ! run_cmd mkfs.ext4 -F -q -L "openchat-$DISK" "$tmp"; then
    run_cmd rm -f "$tmp"
    die "mkfs.ext4 failed for $tmp; removed it, nothing was copied"
  fi
  run_cmd mv -f "$tmp" "$IMG"
}

ensure_mounted() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "mkdir -p $MNT && mount -o loop $IMG $MNT (skipped when already mounted)"
    return 0
  fi
  mkdir -p "$MNT"
  if is_mounted "$MNT"; then
    note "image: $MNT already mounted"
    return 0
  fi
  if ! mount -o loop "$IMG" "$MNT"; then
    die "mount failed for $IMG; the image is kept and nothing was copied"
  fi
  note "image: mounted $MNT"
}

detach() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "sync && umount $MNT"
    return 0
  fi
  run_cmd sync
  if is_mounted "$MNT"; then
    run_cmd umount "$MNT"
    note "image: detached $MNT"
  fi
}

# Entries an adopted disk may legitimately hold without a migration stamp.
root_entries() {
  find "$MNT" -mindepth 1 -maxdepth 1 ! -name "$DISK_MARKER" ! -name "$STAMP" 2>/dev/null |
    wc -l | tr -d ' '
}

disk_file_count() {
  find "$MNT" -type f ! -name "$DISK_MARKER" ! -name "$STAMP" 2>/dev/null |
    wc -l | tr -d ' '
}

disk_kib() {
  du -sk "$MNT" 2>/dev/null | awk 'NR == 1 { print $1 }'
}

# Refuse before touching the service: an image with a stamp is migrated, one
# with foreign files is unknown. Only a disk that mount-disks.sh created and
# nobody wrote to is adopted.
classify_image() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "inspect $IMG: refuse if it holds $STAMP or data; adopt it if it is empty"
    return 0
  fi
  ensure_mounted
  if [ -e "$STAMP_PATH" ]; then
    die "already migrated: $IMG carries $STAMP, so nothing was copied (move it aside with --rollback to start over)"
  fi
  if [ "$(root_entries)" -ne 0 ]; then
    die "refusing to copy: $IMG holds data and no migration stamp; move it aside with --rollback first"
  fi
  note "image: $IMG exists and is empty (created by mount-disks.sh); adopting it"
}

copy_volume() {
  local out src_files dst_files kib
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "docker run --rm -v $VOLUME_REF:/src:ro -v $MNT:/dst $COPY_IMAGE sh -c 'cd /src && cp -a . /dst/'"
    return 0
  fi
  note "copy: $VOLUME_REF -> $MNT (read-only source, ownership and modes preserved)"
  # Output is discarded on purpose: a failing `cp` prints file names, and a file
  # name is the one thing this script does not report.
  if ! out=$(docker run --rm \
      -v "$VOLUME_REF:/src:ro" \
      -v "$MNT:/dst" \
      "$COPY_IMAGE" \
      sh -c 'cd /src && cp -a . /dst/ && find /src -type f | wc -l' 2>/dev/null); then
    detach
    die "copy failed; image kept at $IMG and volume $VOLUME_REF untouched. Re-run the docker run by hand, without redirecting its output, to see the reason"
  fi
  src_files=$(printf '%s\n' "$out" | tail -n 1 | tr -d '[:space:]')
  case "$src_files" in
    ""|*[!0-9]*) die "the copy helper printed no file count; image kept at $IMG, volume untouched" ;;
  esac
  dst_files=$(disk_file_count)
  kib=$(disk_kib)
  [ "$src_files" = "$dst_files" ] ||
    die "file count mismatch after the copy: source $src_files, disk $dst_files; image kept at $IMG, volume untouched"
  COPIED_FILES=$src_files
  COPIED_KIB=${kib:-0}
  note "copy: $COPIED_FILES file(s), $COPIED_KIB KiB on the disk (source $VOLUME_FILES file(s), $VOLUME_KIB KiB)"
}

write_stamp() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "write $STAMP_PATH (volume id, file count, KiB, timestamp; no content)"
    return 0
  fi
  {
    printf 'volume=%s\nfiles=%s\nkib=%s\nat=%s\n' \
      "$VOLUME_REF" "$COPIED_FILES" "$COPIED_KIB" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$STAMP_PATH"
  note "stamp: $STAMP_PATH (volume id, file count, KiB and timestamp)"
}

rollback_hint() {
  note "restore: bring the release back whose overlay mounts the base volume $VOLUME_REF, then start the service:"
  note "  docker compose --project-name $PROJECT --env-file $STACK_DIR/.env --file $COMPOSE_FILE up -d $SERVICE"
  note "the volume $VOLUME_REF was never modified; an old image may be deleted only after a verified restore"
}

do_apply() {
  local have_image=0
  if [ "$DRY_RUN" -eq 0 ]; then
    docker_available || die "docker is required: the volume is readable only through it"
    [ -f "$COMPOSE_FILE" ] ||
      die "no rendered release at $COMPOSE_FILE; a deploy writes it, and the service name must resolve"
    [ -f "$STACK_DIR/.env" ] || die "missing host-only env file: $STACK_DIR/.env"
  fi
  if [ "$DRY_RUN" -eq 1 ] && ! docker_available; then
    # A plan without a daemon: no volume can be probed, so nothing is claimed
    # about counts and the image is described by its cap only.
    plan "stop only the $SERVICE service (docker compose … stop $SERVICE)"
    plan "create and format $IMG (${IMAGE_MIB} MiB ext4) unless it already exists"
    plan "mount -o loop $IMG $MNT"
    plan "copy $VOLUME_REF -> $MNT with a read-only source bind (cp -a, ownership and modes preserved)"
    plan "write $STAMP_PATH; umount $MNT; keep the image"
    note "dry run: docker is not available here, so the volume was not probed; nothing was changed"
    return 0
  fi
  if [ -f "$IMG" ]; then
    have_image=1
    classify_image
  fi

  if ! volume_exists; then
    note "volume: $VOLUME_REF not found; nothing to migrate"
    note "a fresh host creates the bounded disk with deploy/remote/mount-disks.sh"
    return 0
  fi

  probe_volume
  check_capacity
  compose_stop
  if [ "$have_image" -eq 0 ]; then
    create_image
    ensure_mounted
  fi
  copy_volume
  write_stamp
  detach

  note "next: deploy the release whose overlay mounts $MNT; mount-disks.sh mounts it on every boot"
  note "rollback: $SCRIPT --stack-dir $STACK_DIR --rollback"
  [ "$DRY_RUN" -eq 1 ] && note "dry run: no service was stopped, no image, mount or copy was made"
  return 0
}

do_rollback() {
  local stamp target n
  if [ ! -f "$IMG" ]; then
    note "rollback: no image at $IMG; nothing to move"
    rollback_hint
    return 0
  fi
  if is_mounted "$MNT"; then
    detach
  else
    note "rollback: $MNT is not mounted"
  fi
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="$IMG.rollback-$stamp"
  n=1
  while [ -e "$target" ]; do
    target="$IMG.rollback-$stamp-$n"
    n=$((n + 1))
  done
  run_cmd mv "$IMG" "$target"
  note "rollback: moved the image to $target (kept; nothing was deleted)"
  rollback_hint
  [ "$DRY_RUN" -eq 1 ] && note "dry run: the image and the mount were not touched"
  return 0
}

# Every mutating call goes through here, so a dry run can print the exact
# command it would run without executing it.
run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$*"
    return 0
  fi
  "$@"
}

main() {
  parse_args "$@"
  resolve_paths
  validate_inputs
  case "$MODE" in
    apply) do_apply ;;
    rollback) do_rollback ;;
  esac
}

main "$@"
