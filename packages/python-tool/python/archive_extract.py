"""archive_extract: write plain ZIP entries into one validated chat subdir.

The Node side validates the source and the target directory and passes the
quota counters. Every entry is checked before its first byte is written, and a
refusal removes everything this run created so a failed extract never leaves a
partial tree behind.
"""

import os
import zipfile
from typing import Any, Dict, List, Tuple

from _common import emit_json, fail, run
from archive_guards import (
    CHUNK_BYTES,
    MAX_ENTRIES,
    MAX_TOTAL_UNCOMPRESSED,
    NOFOLLOW,
    Refusal,
    check_budget,
    check_entry,
    check_ratio,
    ensure_dir,
)


def read_limits(payload: dict) -> Tuple[str, str, str, int, int, int]:
    path = payload.get("path")
    output_dir = payload.get("outputDir")
    subdir = payload.get("subdir")
    numbers = []
    for key in ("usedBytes", "quotaBytes", "maxFileBytes"):
        value = payload.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            fail("invalid_input")
        numbers.append(value)
    if not isinstance(path, str) or not path:
        fail("invalid_input")
    if not isinstance(output_dir, str) or not output_dir:
        fail("invalid_input")
    if not isinstance(subdir, str) or not subdir:
        fail("invalid_input")
    return path, output_dir, subdir, numbers[0], numbers[1], numbers[2]


def cleanup(files: List[str], directories: List[str]) -> None:
    for path in reversed(files):
        try:
            os.unlink(path)
        except OSError:
            pass
    for path in reversed(directories):
        try:
            os.rmdir(path)
        except OSError:
            pass


def write_entry(archive, info, target: str, declared: int, limits: Tuple[int, int, int, int]) -> int:
    max_file, quota, used, written = limits
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW
    count = 0
    descriptor = os.open(target, flags, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        with archive.open(info, "r") as source:
            while True:
                chunk = source.read(CHUNK_BYTES)
                if not chunk:
                    break
                count += len(chunk)
                if count > declared:
                    raise Refusal("zip_bomb")
                if count > max_file:
                    raise Refusal("too_large")
                if used + written + count > quota:
                    raise Refusal("quota_exceeded")
                output.write(chunk)
    return count


def main(payload: dict) -> None:
    path, output_dir, subdir, used, quota, max_file = read_limits(payload)
    created_dirs: List[str] = []
    written_files: List[str] = []
    planned: List[Tuple[Any, List[str], bool, str]] = []
    names: List[str] = []

    try:
        with zipfile.ZipFile(path) as archive:
            uncompressed = compressed = 0
            declared_total = 0
            seen = set()
            for info in archive.infolist():
                if len(planned) >= MAX_ENTRIES:
                    raise Refusal("too_many_entries")
                parts, directory = check_entry(info)
                check_ratio(info.file_size, info.compress_size)
                uncompressed += info.file_size
                compressed += info.compress_size
                if uncompressed > MAX_TOTAL_UNCOMPRESSED:
                    raise Refusal("too_large")
                target = os.path.join(output_dir, *parts)
                if target in seen or os.path.lexists(target):
                    raise Refusal("already_exists")
                seen.add(target)
                check_budget(info.file_size, max_file, quota, used, declared_total)
                declared_total += info.file_size
                planned.append((info, parts, directory, target))
            check_ratio(uncompressed, compressed)

            ensure_dir(output_dir, created_dirs)
            total = 0
            for info, parts, directory, target in planned:
                relative = "/".join(parts)
                if not directory:
                    for index in range(1, len(parts)):
                        ensure_dir(os.path.join(output_dir, *parts[:index]), created_dirs)
                    total += write_entry(
                        archive, info, target, info.file_size, (max_file, quota, used, total)
                    )
                    written_files.append(target)
                else:
                    ensure_dir(target, created_dirs)
                names.append(relative)
    except Refusal as refusal:
        cleanup(written_files, created_dirs)
        fail(refusal.code)
    except Exception:
        cleanup(written_files, created_dirs)
        fail("render_failed")

    emit_json(
        {
            "ok": True,
            "directory": subdir,
            "files": names,
            "bytes": total,
            "count": len(names),
        }
    )


run(main)
