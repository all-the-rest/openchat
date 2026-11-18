"""Shared ZIP inspection for archive_list.py and archive_extract.py.

Python's stdlib `zipfile` is the only reader: the agent image has no `unzip`
and this slice adds no dependency. Every rejection is one stable code and
`run_archive` keeps tracebacks and library text off stdout. The caps are
repeated in packages/python-tool/src/limits.ts; both sides enforce the same
numbers so a direct script call is no weaker than the MCP path.

Threat model in docs/implementation/26-archives.md: traversal and absolute
targets, symlink/device entries, encrypted entries, duplicate names, bombs by
declared size and by bytes actually decompressed, and the chat file quota.
"""

import json
import os
import re
import stat
import sys
import zipfile

from _common import cap_memory, fail, read_request

MAX_ENTRIES = 500
MAX_DEPTH = 10
MAX_UNCOMPRESSED = 200 * 1024 * 1024
BOMB_RATIO = 100
BOMB_FLOOR = 10 * 1024 * 1024
CHUNK = 64 * 1024
MAX_SEGMENT = 200
MAX_NAME = 1000
MAX_DIRECTORY = 64

DRIVE = re.compile(r"^[A-Za-z]:")
DIRECTORY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class Guard(Exception):
    """A refusal found while writing, so the writer can roll back first."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Entry:
    __slots__ = ("info", "parts", "directory")

    def __init__(self, info: zipfile.ZipInfo, parts: list, directory: bool) -> None:
        self.info = info
        self.parts = parts
        self.directory = directory


def _segments(name: str) -> tuple:
    """Path parts of one entry name; the first unsafe shape wins."""
    if not name or len(name) > MAX_NAME or CONTROL.search(name):
        raise Guard("unsafe_entry")
    if "\\" in name or name.startswith("/") or DRIVE.match(name):
        raise Guard("unsafe_entry")
    trailing = name.endswith("/")
    parts = name[:-1].split("/") if trailing else name.split("/")
    for part in parts:
        if part in ("", ".", "..") or len(part) > MAX_SEGMENT:
            raise Guard("unsafe_entry")
    if len(parts) > MAX_DEPTH:
        raise Guard("too_deep")
    return parts, trailing


def _read_entries(archive: zipfile.ZipFile, archive_bytes: int) -> tuple:
    infos = archive.infolist()
    if len(infos) > MAX_ENTRIES:
        fail("too_many_entries")
    entries = []
    seen = set()
    uncompressed = 0
    compressed = 0
    for info in infos:
        if info.flag_bits & 0x1:
            fail("encrypted")
        parts, trailing = _segments(info.filename)
        mode = info.external_attr >> 16
        # Some writers store only permission bits (0o600) with no file type;
        # only an explicit non-regular, non-directory type is refused.
        kind = stat.S_IFMT(mode) if mode else 0
        if kind and kind != stat.S_IFREG and kind != stat.S_IFDIR:
            # Symlinks, block/character devices, FIFOs and sockets.
            fail("unsafe_entry")
        directory = trailing or kind == stat.S_IFDIR
        key = "/".join(parts)
        if key in seen:
            # A duplicate name is the only alias a ZIP can carry; never write
            # the same target twice.
            fail("unsafe_entry")
        seen.add(key)
        entries.append(Entry(info, parts, directory))
        uncompressed += int(info.file_size)
        compressed += int(info.compress_size)
    if uncompressed > MAX_UNCOMPRESSED:
        fail("archive_too_large")
    if uncompressed > BOMB_FLOOR and uncompressed > archive_bytes * BOMB_RATIO:
        fail("bomb")
    return entries, uncompressed, compressed


def _open(path: str) -> tuple:
    if not isinstance(path, str) or not path.startswith("/") or CONTROL.search(path):
        fail("invalid_input")
    try:
        archive = zipfile.ZipFile(path)
        archive_bytes = os.path.getsize(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        fail("bad_archive")
    try:
        entries, uncompressed, compressed = _read_entries(archive, archive_bytes)
    except BaseException:
        archive.close()
        raise
    return archive, entries, uncompressed, compressed, archive_bytes


def list_archive(path: str) -> dict:
    archive, entries, uncompressed, compressed, archive_bytes = _open(path)
    with archive:
        listing = [
            {
                "name": entry.info.filename,
                "size": int(entry.info.file_size),
                "compressedSize": int(entry.info.compress_size),
                "directory": entry.directory,
            }
            for entry in entries
        ]
    directories = sum(1 for entry in entries if entry.directory)
    return {
        "bytes": archive_bytes,
        "entries": listing,
        "totals": {
            "entries": len(entries),
            "files": len(entries) - directories,
            "directories": directories,
            "uncompressedBytes": uncompressed,
            "compressedBytes": compressed,
        },
    }


def _check_directory(base: str, directory: str) -> str:
    if (
        not isinstance(directory, str)
        or len(directory) > MAX_DIRECTORY
        or not DIRECTORY.match(directory)
        or directory in (".", "..")
    ):
        fail("invalid_input")
    if not isinstance(base, str) or not base.startswith("/") or CONTROL.search(base):
        fail("invalid_input")
    try:
        real = os.path.realpath(base)
        if not os.path.isdir(real):
            fail("invalid_input")
    except OSError:
        fail("invalid_input")
    return real


def _integer(payload: dict, key: str) -> int:
    value = payload.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        fail("invalid_input")
    return value


def _ensure_dir(base: str, parts: list, created: list) -> str:
    path = base
    for part in parts:
        path = os.path.join(path, part)
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            try:
                os.mkdir(path, 0o700)
                created.append(path)
            except FileExistsError:
                info = os.lstat(path)
            else:
                continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise Guard("unsafe_entry")
    return path


def _remove(created_files: list, created_dirs: list) -> None:
    for path in reversed(created_files):
        try:
            os.unlink(path)
        except OSError:
            pass
    for path in reversed(created_dirs):
        try:
            os.rmdir(path)
        except OSError:
            pass


def _preflight(entries: list, root: str) -> None:
    for entry in entries:
        target = os.path.join(root, *entry.parts)
        if entry.directory:
            if os.path.lexists(target) and not os.path.isdir(target):
                raise Guard("already_exists")
            continue
        if os.path.lexists(target):
            raise Guard("already_exists")


def _write_entry(
    archive: zipfile.ZipFile,
    entry: Entry,
    target: str,
    used_bytes: int,
    written: int,
    quota_bytes: int,
    max_file_bytes: int,
    archive_bytes: int,
    created_files: list,
) -> int:
    declared = int(entry.info.file_size)
    if declared > max_file_bytes:
        raise Guard("file_too_large")
    if written + declared > MAX_UNCOMPRESSED:
        raise Guard("archive_too_large")
    if used_bytes + written + declared > quota_bytes:
        raise Guard("quota_exceeded")
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise Guard("already_exists")
    created_files.append(target)
    size = 0
    with os.fdopen(fd, "wb") as out, archive.open(entry.info) as source:
        while True:
            chunk = source.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            total = written + size
            # Declared sizes can lie; the counters below see real bytes.
            if size > max_file_bytes:
                raise Guard("file_too_large")
            if total > MAX_UNCOMPRESSED:
                raise Guard("archive_too_large")
            if used_bytes + total > quota_bytes:
                raise Guard("quota_exceeded")
            if total > BOMB_FLOOR and total > archive_bytes * BOMB_RATIO:
                raise Guard("bomb")
            out.write(chunk)
    return size


def extract_archive(payload: dict) -> dict:
    path = payload.get("path")
    directory = payload.get("directory")
    used_bytes = _integer(payload, "usedBytes")
    quota_bytes = _integer(payload, "quotaBytes")
    max_file_bytes = _integer(payload, "maxFileBytes")
    archive, entries, _uncompressed, _compressed, archive_bytes = _open(path)
    created_files = []
    created_dirs = []
    written = 0
    files = []
    with archive:
        try:
            base = _check_directory(payload.get("destination"), directory)
            root = _ensure_dir(base, [directory], created_dirs)
            _preflight(entries, root)
            for entry in entries:
                if entry.directory:
                    _ensure_dir(root, entry.parts, created_dirs)
                    continue
                _ensure_dir(root, entry.parts[:-1], created_dirs)
                target = os.path.join(root, *entry.parts)
                size = _write_entry(
                    archive,
                    entry,
                    target,
                    used_bytes,
                    written,
                    quota_bytes,
                    max_file_bytes,
                    archive_bytes,
                    created_files,
                )
                written += size
                files.append({"path": "/".join(entry.parts), "size": size})
        except Guard as guard:
            _remove(created_files, created_dirs)
            fail(guard.code)
        except SystemExit:
            _remove(created_files, created_dirs)
            raise
        except Exception:
            _remove(created_files, created_dirs)
            fail("bad_archive")
    return {"directory": directory, "files": files, "bytes": written}


def emit_json(payload: dict) -> None:
    sys.stdout.write(json.dumps({"ok": True, **payload}, separators=(",", ":")))
    sys.stdout.flush()


def run_archive(main) -> None:
    cap_memory()
    try:
        main(read_request())
    except SystemExit:
        raise
    except MemoryError:
        fail("too_large")
    except Guard as guard:
        fail(guard.code)
    except Exception:
        fail("internal")
