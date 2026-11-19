"""archive_list: inspect a plain .zip without reading any entry's content."""

import zipfile
from typing import Any, Dict, List

from _common import emit_json, fail, run
from archive_guards import (
    MAX_ENTRIES,
    MAX_TOTAL_UNCOMPRESSED,
    Refusal,
    check_entry,
    check_ratio,
)


def main(payload: dict) -> None:
    path = payload.get("path")
    if not isinstance(path, str) or not path:
        fail("invalid_input")

    entries: List[Dict[str, Any]] = []
    uncompressed = 0
    compressed = 0
    directories = 0
    try:
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                if len(entries) >= MAX_ENTRIES:
                    raise Refusal("too_many_entries")
                _, directory = check_entry(info)
                check_ratio(info.file_size, info.compress_size)
                uncompressed += info.file_size
                compressed += info.compress_size
                if uncompressed > MAX_TOTAL_UNCOMPRESSED:
                    raise Refusal("too_large")
                entries.append(
                    {
                        "name": info.filename,
                        "size": info.file_size,
                        "compressedSize": info.compress_size,
                        "directory": directory,
                    }
                )
                if directory:
                    directories += 1
    except Refusal as refusal:
        fail(refusal.code)
    except Exception:
        fail("not_zip")

    emit_json(
        {
            "ok": True,
            "entries": entries,
            "totals": {
                "entries": len(entries),
                "files": len(entries) - directories,
                "directories": directories,
                "uncompressedBytes": uncompressed,
                "compressedBytes": compressed,
            },
        }
    )


run(main)
