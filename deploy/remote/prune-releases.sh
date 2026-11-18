#!/usr/bin/env bash
#
# Bounded release retention for the OpenChat stack (issue #43, follow-up 8).
#
# Every deploy keeps its release directory, its `src/<tag>` build context and
# its `openchat-*:<tag>` images. A rollback only needs `current` and `previous`,
# so everything older is dead weight (~2.5 GB per release cycle on the host).
#
# This script keeps the newest `--keep` releases (default 2), always including
# `current` and `previous`, and deletes the rest:
#
#   - releases/<name> directories beyond the kept set;
#   - src/<tag> trees whose name is not the tag of a kept release;
#   - openchat-<service>:<tag> images whose tag is not kept.
#
# Safety rules:
#   - `current` and `previous` are required. If either is missing, or a kept
#     release has no `tag` file (releases written before deploy.sh started
#     recording one), nothing is deleted: a tag is never guessed at.
#   - Only refs matching ^openchat-[a-z-]+:[A-Za-z0-9._-]+$ are touched. Other
#     repositories, `latest`, and names outside that shape are left alone.
#   - Paths are executed as argv, never through a shell, so a `--stack-dir`
#     containing a space or a `;` stays one inert word.
#
# deploy/remote/deploy.sh calls this after a successful swap and treats a
# failure as a warning: retention never fails a deploy that already runs.
#
# Usage:
#   prune-releases.sh --stack-dir DIR [--keep N] [--dry-run]

set -euo pipefail

PROG=$(basename "$0")
STACK_DIR=/opt/stacks/openchat
KEEP=2
DRY_RUN=0

usage() {
  cat <<'EOF'
Prune old OpenChat releases, source trees and images.

Usage:
  prune-releases.sh [options]

Options:
  --stack-dir DIR  stack root (default: /opt/stacks/openchat)
  --keep N         releases to keep, including current and previous (default: 2)
  --dry-run        print every deletion; delete nothing
  --help

Nothing is deleted when current, previous or a kept release's tag file is
missing: older releases have no recorded tag and are not guessed at.
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

warn() { printf '%s: %s\n' "$PROG" "$*" >&2; }

require_value() {
  [ "$#" -ge 2 ] || usage_error "$1 needs a value"
}

quote_cmd() {
  local out=""
  local word
  for word in "$@"; do
    out+="${out:+ }$(printf '%q' "$word")"
  done
  printf '%s' "$out"
}

plan() { printf 'would: %s\n' "$(quote_cmd "$@")"; }

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stack-dir) require_value "$@"; STACK_DIR=$2; shift 2 ;;
      --keep) require_value "$@"; KEEP=$2; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done

  case "$STACK_DIR" in
    /*) ;;
    *) usage_error "--stack-dir must be an absolute path: $STACK_DIR" ;;
  esac
  case "$STACK_DIR" in
    *[[:cntrl:]]*) usage_error "--stack-dir must not contain control characters" ;;
  esac
  case "/$STACK_DIR/" in
    */../*) usage_error "--stack-dir must not contain a '..' segment: $STACK_DIR" ;;
  esac
  case "$KEEP" in
    ""|*[!0-9]*) usage_error "--keep must be a positive integer: $KEEP" ;;
  esac
  [ "$KEEP" -ge 2 ] || usage_error "--keep must be at least 2 (current and previous): $KEEP"
}

# Release dirs, source-tree names and image tags are all constrained to this
# shape. Anything else is skipped rather than interpreted.
is_safe_name() {
  case "$1" in
    ""|.|..|.*|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

in_list() {
  local needle=$1
  local item
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

# The tag a release needs, or empty when the file is missing or malformed.
read_tag() {
  local path="$STACK_DIR/releases/$1/tag" tag=""
  [ -f "$path" ] || return 0
  tag=$(sed -n '1p' "$path" 2>/dev/null | tr -d '\r')
  case "$tag" in
    ""|*[!A-Za-z0-9._-]*) return 0 ;;
  esac
  printf '%s' "$tag"
}

release_names() {
  find "$STACK_DIR/releases" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null |
    sed 's#^.*/##' |
    LC_ALL=C sort -r
}

remove_path() {
  local path=$1 label=$2
  if [ "$DRY_RUN" -eq 1 ]; then
    plan rm -rf "$path"
    return 0
  fi
  if rm -rf "$path"; then
    note "removed $label: $path"
  else
    warn "could not remove $path"
  fi
}

main() {
  parse_args "$@"

  [ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
  STACK_DIR=$(cd "$STACK_DIR" && pwd -P)

  current_name=$(readlink "$STACK_DIR/current" 2>/dev/null || true)
  previous_name=$(readlink "$STACK_DIR/previous" 2>/dev/null || true)
  current_name=${current_name#releases/}
  previous_name=${previous_name#releases/}

  if [ -z "$current_name" ] || [ ! -d "$STACK_DIR/releases/$current_name" ]; then
    note "retention: no current release; nothing is deleted"
    return 0
  fi
  if [ -z "$previous_name" ] || [ ! -d "$STACK_DIR/releases/$previous_name" ]; then
    note "retention: no previous release; keep current and previous is not possible, nothing is deleted"
    return 0
  fi
  if ! is_safe_name "$current_name" || ! is_safe_name "$previous_name"; then
    note "retention: current or previous does not name a plain release directory; nothing is deleted"
    return 0
  fi

  current_tag=$(read_tag "$current_name")
  previous_tag=$(read_tag "$previous_name")
  if [ -z "$current_tag" ] || [ -z "$previous_tag" ]; then
    note "retention: current or previous has no tag file; older releases without a tag are not guessed at, nothing is deleted"
    return 0
  fi

  # The kept set: current, previous and enough of the newest remaining release
  # dirs to reach --keep. Directory names are UTC timestamps, so name order is
  # chronological.
  kept_releases=" $current_name $previous_name "
  extra=0
  for name in $(release_names); do
    is_safe_name "$name" || continue
    in_list "$name" $kept_releases && continue
    [ "$extra" -lt $((KEEP - 2)) ] || continue
    kept_releases="$kept_releases$name "
    extra=$((extra + 1))
  done

  kept_tags=" $current_tag $previous_tag "
  for name in $kept_releases; do
    tag=$(read_tag "$name")
    if [ -z "$tag" ]; then
      note "retention: kept release $name has no tag file; nothing is deleted"
      return 0
    fi
    in_list "$tag" $kept_tags || kept_tags="$kept_tags$tag "
  done

  note "retention: keeping current=$current_name ($current_tag) previous=$previous_name ($previous_tag)"

  removed_releases=0
  for name in $(release_names); do
    is_safe_name "$name" || { warn "skipping unrecognised release entry: $name"; continue; }
    in_list "$name" $kept_releases && continue
    remove_path "$STACK_DIR/releases/$name" "release"
    removed_releases=$((removed_releases + 1))
  done

  removed_sources=0
  for path in "$STACK_DIR/src"/*; do
    [ -d "$path" ] || continue
    [ -L "$path" ] && continue
    name=${path##*/}
    is_safe_name "$name" || { warn "skipping unrecognised source tree: $path"; continue; }
    in_list "$name" $kept_tags && continue
    remove_path "$path" "source tree"
    removed_sources=$((removed_sources + 1))
  done

  removed_images=0
  if command -v docker >/dev/null 2>&1; then
    refs=$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
    for ref in $refs; do
      printf '%s\n' "$ref" | grep -Eq '^openchat-[a-z-]+:[A-Za-z0-9._-]+$' || continue
      tag=${ref##*:}
      [ "$tag" = "latest" ] && continue
      in_list "$tag" $kept_tags && continue
      if [ "$DRY_RUN" -eq 1 ]; then
        plan docker rmi "$ref"
      elif docker rmi "$ref"; then
        note "removed image: $ref"
      else
        warn "could not remove image: $ref"
      fi
      removed_images=$((removed_images + 1))
    done
  else
    warn "docker not found; images were not pruned"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    note "dry run: would remove $removed_releases release(s), $removed_sources source tree(s) and $removed_images image(s)"
  else
    note "retention: removed $removed_releases release(s), $removed_sources source tree(s) and $removed_images image(s)"
  fi
}

main "$@"
