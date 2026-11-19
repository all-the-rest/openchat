"""Shared rules for the two plain-ZIP scripts.

Every check here is about an *entry* before a single byte of it is trusted or
written. Names are POSIX-style: the ZIP spec mandates forward slashes, so a
backslash is refused rather than interpreted differently per platform. A
refusal carries one stable code; no path, name or exception text is emitted.
"""

import os
import re
import stat
from typing import List, Tuple

# Exact caps, mirrored in src/limits.ts and docs/implementation/26-archives.md.
MAX_ENTRIES = 500
MAX_DEPTH = 10
MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024
RATIO_LIMIT = 100
BOMB_MIN_UNCOMPRESSED = 10 * 1024 * 1024
CHUNK_BYTES = 64 * 1024

DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class Refusal(Exception):
    """One stable code, raised before any write and cleaned up by the caller."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def check_name(name: str) -> List[str]:
    """Return the safe path components, or refuse a hostile entry name."""
    if "\x00" in name or "\\" in name:
        raise Refusal("unsafe_name")
    if name.startswith("/") or DRIVE_PREFIX.match(name):
        raise Refusal("unsafe_name")
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if not parts or ".." in parts or len(parts) > MAX_DEPTH:
        raise Refusal("unsafe_name")
    return parts


def check_entry(info) -> Tuple[List[str], bool]:
    """Validate encryption, name, depth and Unix mode; report a directory."""
    if info.flag_bits & 0x1:
        raise Refusal("encrypted")
    parts = check_name(info.filename)
    directory = info.filename.endswith("/")
    mode = (info.external_attr >> 16) & 0xFFFF
    kind = stat.S_IFMT(mode)
    # Many portable tools store only permission bits (kind 0), or no mode at
    # all. An explicit kind other than regular file or directory is a symlink,
    # link or device and is refused before its bytes are read.
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise Refusal("unsafe_entry")
    if kind == stat.S_IFDIR and not directory:
        raise Refusal("unsafe_entry")
    return parts, directory


def check_ratio(file_size: int, compressed_size: int) -> None:
    """Declared-size bomb check: >100:1 once past 10 MiB uncompressed."""
    if (
        file_size > BOMB_MIN_UNCOMPRESSED
        and file_size > RATIO_LIMIT * max(compressed_size, 1)
    ):
        raise Refusal("zip_bomb")


def check_budget(
    file_size: int, max_file_bytes: int, quota_bytes: int, used: int, written: int
) -> None:
    """Both caps are checked *before* an entry is opened for writing."""
    if file_size > max_file_bytes:
        raise Refusal("too_large")
    if used + written + file_size > quota_bytes:
        raise Refusal("quota_exceeded")


def ensure_dir(path: str, created: List[str]) -> None:
    """Create one directory below the validated target, never through a link."""
    if os.path.lexists(path):
        if not os.path.isdir(path) or os.path.islink(path):
            raise Refusal("unsafe_entry")
        return
    os.mkdir(path, 0o700)
    created.append(path)
