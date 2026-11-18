"""docx_from_text: a DOCX from a validated block list, byte-for-byte stable.

The TypeScript validator decides what a document may contain and rejects
oversized input before a process starts. This script re-checks the same
ceilings, because it is also the thing a future caller could invoke directly.
Every refusal is one stable code on stdout; no exception text or traceback ever
leaves the process.

Determinism: python-docx writes the current time into the zip entries and the
default core properties. Both are pinned here (fixed `FIXED_TIME`, fixed
author, revision 1), and `canonical` rewrites the package with fixed zip
timestamps, so the same request yields the same bytes.
"""

import datetime
import io
import re
import zipfile

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.shared import Cm, Pt

from _common import emit, fail, run

MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

MAX_BLOCKS = 500
MAX_TABLE_ROWS = 50
MAX_TABLE_COLUMNS = 8
MAX_TEXT_CHARS = 20_000
# Hard ceiling named by issue #22. The artifact wrapper embeds the file and
# therefore stops at `_common.MAX_FILE_BYTES`; this cap is the producer's own
# bound, checked before the bytes are base64-encoded.
MAX_DOCX_BYTES = 10 * 1024 * 1024

FIXED_TIME = datetime.datetime(2000, 1, 1, 0, 0, 0)
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
TEXT_KINDS = ("paragraph", "bullet", "code")


def plain(value, allow_newline: bool = False) -> str:
    """One line of user text: no control characters, no surprise line breaks."""
    if not isinstance(value, str) or CONTROL.search(value):
        fail("invalid_input")
    if not allow_newline and ("\n" in value or "\t" in value):
        fail("invalid_input")
    return value


def normalise(blocks) -> list:
    """Defensive second pass over the block list the validator already checked."""
    if not isinstance(blocks, list) or not blocks:
        fail("invalid_input")
    if len(blocks) > MAX_BLOCKS:
        fail("too_many")

    total = 0
    result = []
    for block in blocks:
        if not isinstance(block, dict):
            fail("invalid_input")
        kind = block.get("kind")
        if kind == "table":
            rows = block.get("rows")
            if not isinstance(rows, list) or not rows:
                fail("invalid_input")
            if len(rows) > MAX_TABLE_ROWS:
                fail("too_many")
            width = 0
            cells: list = []
            for row in rows:
                if not isinstance(row, list) or not row:
                    fail("invalid_input")
                if len(row) > MAX_TABLE_COLUMNS:
                    fail("too_many")
                if width == 0:
                    width = len(row)
                elif len(row) != width:
                    fail("invalid_input")
                values = [plain(cell) for cell in row]
                total += sum(len(value) for value in values)
                cells.append(values)
            result.append({"kind": "table", "rows": cells})
            continue

        if kind not in ("heading", *TEXT_KINDS):
            fail("invalid_input")
        text = plain(block.get("text"), allow_newline=kind == "code")
        total += len(text)
        if kind == "heading":
            level = block.get("level")
            if isinstance(level, bool) or not isinstance(level, int) or level not in (1, 2, 3):
                fail("invalid_input")
            result.append({"kind": "heading", "level": level, "text": text})
            continue
        result.append({"kind": kind, "text": text})

    if total > MAX_TEXT_CHARS:
        fail("too_many")
    return result


def add_table(document, rows: list) -> None:
    table = document.add_table(rows=len(rows), cols=len(rows[0]))
    table.style = "Table Grid"
    for row_index, row in enumerate(rows):
        for column, value in enumerate(row):
            cell = table.cell(row_index, column)
            cell.text = value
            if row_index > 0:
                continue
            for cell_paragraph in cell.paragraphs:
                for run_ in cell_paragraph.runs:
                    run_.bold = True


def add_block(document, block: dict) -> None:
    kind = block["kind"]
    if kind == "heading":
        document.add_heading(block["text"], level=block["level"])
        return
    if kind == "paragraph":
        document.add_paragraph(block["text"])
        return
    if kind == "bullet":
        document.add_paragraph(block["text"], style="List Bullet")
        return
    if kind == "code":
        paragraph = document.add_paragraph(style="Code")
        lines = block["text"].split("\n")
        run_ = paragraph.add_run(lines[0])
        for line in lines[1:]:
            run_.add_break()
            run_.add_text(line)
        return
    add_table(document, block["rows"])


def build_document(blocks: list, title) -> Document:
    """A4, 2 cm margins, one small style set: Title, Normal, Heading 1-3, List
    Bullet, Table Grid and a generated `Code` paragraph style."""
    document = Document()
    section = document.sections[0]
    section.page_width = Cm(21)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2)
    section.bottom_margin = Cm(2)
    section.left_margin = Cm(2)
    section.right_margin = Cm(2)

    code = document.styles.add_style("Code", WD_STYLE_TYPE.PARAGRAPH)
    code.base_style = document.styles["Normal"]
    code.font.name = "Courier New"
    code.font.size = Pt(9)

    if title:
        document.add_paragraph(title, style="Title")
    for block in blocks:
        add_block(document, block)

    properties = document.core_properties
    properties.title = title or ""
    properties.author = "OpenChat"
    properties.last_modified_by = "OpenChat"
    properties.comments = ""
    properties.subject = ""
    properties.keywords = ""
    properties.category = ""
    properties.created = FIXED_TIME
    properties.modified = FIXED_TIME
    properties.revision = 1
    return document


def canonical(data: bytes) -> bytes:
    """Rewrite the OOXML zip with fixed entry timestamps and permissions.

    Part order and compressed bytes are preserved; only the metadata that makes
    two otherwise identical packages differ is replaced.
    """
    source = zipfile.ZipFile(io.BytesIO(data))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            entry = zipfile.ZipInfo(info.filename, date_time=ZIP_TIME)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o600 << 16
            target.writestr(entry, source.read(info.filename))
    return output.getvalue()


def finalize(data: bytes) -> bytes:
    if len(data) > MAX_DOCX_BYTES:
        fail("too_large")
    result = canonical(data)
    if len(result) > MAX_DOCX_BYTES:
        fail("too_large")
    return result


def main(payload: dict) -> None:
    blocks = normalise(payload.get("blocks"))
    title = payload.get("title")
    if title is not None and not isinstance(title, str):
        fail("invalid_input")

    output = io.BytesIO()
    build_document(blocks, title).save(output)
    emit(str(payload["filename"]), MEDIA_TYPE, finalize(output.getvalue()))


if __name__ == "__main__":
    run(main)
