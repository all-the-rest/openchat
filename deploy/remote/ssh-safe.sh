#!/usr/bin/env bash
#
# Quoting and input validation for the SSH driver (issue #20).
#
# Sourced by deploy/remote/deploy.sh; it is not a standalone command. Every
# value the driver interpolates into a remote command line passes through
# `shquote` *and* one of the validators: validation keeps hostile
# metacharacters out, quoting keeps an innocent space (a predecessor path may
# contain one) from splitting into two argv words.
#
# `ssh` joins its argv with spaces and the remote shell parses the result, so a
# remote command is always assembled as ONE quoted string, never as separate
# ssh arguments.

# POSIX single-quote quoting: `it's` becomes `'it'\''s'`.
shquote() {
  local s=$1
  s=${s//\'/\'\\\'\'}
  printf "'%s'" "$s"
}

quote_cmd() {
  local out=""
  local word
  for word in "$@"; do
    out+="${out:+ }$(shquote "$word")"
  done
  printf '%s' "$out"
}

# A path that reaches a remote command must stay under `/`: absolute, no
# control bytes, and no `..` segment that could climb out of its root.
validate_path() {
  local name=$1 value=$2
  case "$value" in
    /*) ;;
    *) usage_error "$name must be an absolute path: $value" ;;
  esac
  case "$value" in
    *[[:cntrl:]]*) usage_error "$name must not contain control characters" ;;
  esac
  case "/$value/" in
    */../*) usage_error "$name must not contain a '..' segment: $value" ;;
  esac
}

validate_host() {
  if [[ ! $HOST =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]]; then
    usage_error "--host must be USER@HOST with only letters, digits, dots and dashes: $HOST"
  fi
}

validate_version() {
  if [[ ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    usage_error "--expect-version must look like 2.0.0: $1"
  fi
}

validate_size() {
  local name=$1 value=$2
  if [[ ! $value =~ ^[0-9]+[KkMmGgTt]$ ]]; then
    usage_error "$name must be a number with a K/M/G/T suffix: $value"
  fi
  [ "${value%?}" -gt 0 ] || usage_error "$name must be positive: $value"
}

# Called once after all flags are parsed, before any ssh/rsync runs.
validate_inputs() {
  validate_host
  validate_path "--stack-dir" "$STACK_DIR"
  validate_path "--predecessor-env" "$PREDECESSOR_ENV"
  [ -z "$EXPECT_VERSION" ] || validate_version "$EXPECT_VERSION"
  validate_size "--artifacts-size" "$ARTIFACTS_SIZE"
  validate_size "--workspace-size" "$WORKSPACE_SIZE"
  validate_size "--dind-size" "$DIND_SIZE"
  validate_size "--reserve" "$RESERVE"
  if [ -n "$TAG" ]; then
    case "$TAG" in
      *[!A-Za-z0-9._-]*) usage_error "--tag allows only letters, digits, dots, dashes and underscores: $TAG" ;;
    esac
  fi
}
