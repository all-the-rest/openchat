"""archive_list: list a plain .zip with the fixed caps.

`read_document` reads DOCX/XLSX/PPTX; this script is only for plain archives.
"""

from _archive import emit_json, list_archive, run_archive
from _common import fail


def main(payload: dict) -> None:
    path = payload.get("path")
    if not isinstance(path, str) or not path.startswith("/"):
        fail("invalid_input")
    emit_json(list_archive(path))


run_archive(main)
