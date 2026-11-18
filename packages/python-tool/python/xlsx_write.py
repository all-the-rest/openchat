"""xlsx_write: one sheet with typed cells and an explicit formula map."""

import datetime
import io

from openpyxl import Workbook
from openpyxl.styles import Font

from _common import emit, fail, run

MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
FIXED_TIME = datetime.datetime(2000, 1, 1, 0, 0, 0)


def clean_strings(worksheet) -> None:
    # openpyxl treats a leading `=` as a formula. A data cell is data: force the
    # string type after writing so an imported value cannot become executable.
    for row in worksheet.iter_rows(min_row=2):
        for cell in row:
            if isinstance(cell.value, str) and cell.value.startswith("="):
                cell.data_type = "s"


def main(payload: dict) -> None:
    headers = payload.get("headers")
    rows = payload.get("rows")
    formulas = payload.get("formulas") or {}
    if not isinstance(headers, list) or not isinstance(rows, list):
        fail("invalid_input")
    if not isinstance(formulas, dict):
        fail("invalid_input")

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = str(payload["sheet"])
    sheet.append([str(header) for header in headers])
    for cell in sheet[1]:
        cell.font = Font(bold=True)

    for row in rows:
        sheet.append(row)
    clean_strings(sheet)

    for reference, formula in formulas.items():
        expression = str(formula)
        sheet[str(reference)] = expression if expression.startswith("=") else "=" + expression

    workbook.properties.creator = "OpenChat"
    workbook.properties.lastModifiedBy = "OpenChat"
    workbook.properties.created = FIXED_TIME
    workbook.properties.modified = FIXED_TIME

    output = io.BytesIO()
    workbook.save(output)
    emit(str(payload["filename"]), MEDIA_TYPE, output.getvalue())


run(main)
