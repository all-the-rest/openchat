"""xlsx_write: write typed cells into one workbook."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import emit, fail, local_path, run  # noqa: E402

from openpyxl import Workbook  # noqa: E402

MAX_ROWS = 5_000
MAX_CELLS = 100


def handler(request):
    sheets = request.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        fail("invalid_output")
    output = local_path(request, "output")

    workbook = Workbook()
    # Drop the implicit sheet: the request names every sheet explicitly.
    workbook.remove(workbook.active)
    for sheet in sheets:
        if not isinstance(sheet, dict):
            fail("invalid_output")
        name = sheet.get("name")
        rows = sheet.get("rows")
        if not isinstance(name, str) or not name or not isinstance(rows, list):
            fail("invalid_output")
        if len(rows) > MAX_ROWS:
            fail("crashed")
        worksheet = workbook.create_sheet(title=name)
        for row in rows:
            if not isinstance(row, list) or not row or len(row) > MAX_CELLS:
                fail("invalid_output")
            worksheet.append(row)

    workbook.save(output)
    if os.path.getsize(output) == 0:
        fail("crashed")
    emit({"ok": True, "file": os.path.basename(output)})


run(handler)
