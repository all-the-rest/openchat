#!/usr/bin/env bash
#
# Escape one value for a Docker Compose `.env` file (issue #20).
#
# Compose interpolates `$…` inside env-file values. A bcrypt digest such as
# `$2b$12$abc…` therefore loses every `$`-prefixed run that is not a known
# variable: the file renders as `$2b$12` and login can never succeed, silently.
# `$$` is Compose's escape for a literal dollar sign.
#
# This filter is idempotent: an input that is already escaped (`$$2b$$12…`)
# passes through unchanged, so running the bootstrap again cannot double it.
# bcrypt's alphabet (`./A-Za-z0-9`) never contains `$$`, so the "already escaped"
# rule has no false positive for a digest.
#
# stdin: one raw value. stdout: the same value with each lone `$` doubled. No
# newline is added; callers embed the result in a line themselves.

set -euo pipefail

awk '
{
  value = $0
  out = ""
  n = length(value)
  for (i = 1; i <= n; i++) {
    char = substr(value, i, 1)
    if (char == "$") {
      out = out "$$"
      if (i < n && substr(value, i + 1, 1) == "$") i++
    } else {
      out = out char
    }
  }
  printf "%s", out
}
'
