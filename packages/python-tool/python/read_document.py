"""read_document: DOCX, XLSX and PDF text as Markdown for the agent."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import emit, fail, local_path, run, truncate  # noqa: E402


def markdown_table(rows):
    if not rows:
        return []
    width = max(len(row) for row in rows)
    normalised = []
    for row in rows:
        cells = []
        for cell in row:
            value = "" if cell is None else str(cell)
            cells.append(value.replace("|", "\\|").replace("\n", " ").strip())
        cells.extend([""] * (width - len(cells)))
        normalised.append(cells)
    header, *body = normalised
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join(["---"] * width) + " |"]
    for row in body:
        lines.append("| " + " | ".join(row) + " |")
    return lines


def read_docx(path):
    from docx import Document

    document = Document(path)
    parts = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style = (paragraph.style.name or "").lower()
        if style.startswith("heading"):
            level = style.replace("heading", "").strip()
            depth = int(level) if level.isdigit() else 2
            parts.append("#" * max(1, min(depth, 6)) + " " + text)
        elif style == "title":
            parts.append("# " + text)
        else:
            parts.append(text)
    for index, table in enumerate(document.tables, start=1):
        parts.append("## Table %d" % index)
        rows = []
        for row in table.rows:
            rows.append([cell.text.strip() for cell in row.cells])
        parts.extend(markdown_table(rows))
    for section_index, section in enumerate(document.sections, start=1):
        for label, part in (("Header", section.header), ("Footer", section.footer)):
            text = "\n".join(p.text.strip() for p in part.paragraphs if p.text.strip())
            if text:
                parts.append("### %s %d\n\n%s" % (label, section_index, text))
    return "\n\n".join(parts)


def read_xlsx(path):
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True, data_only=False)
    parts = []
    for worksheet in workbook.worksheets:
        parts.append("## " + str(worksheet.title))
        rows = []
        for row in worksheet.iter_rows(values_only=True):
            if row is None or all(cell is None or str(cell).strip() == "" for cell in row):
                continue
            rows.append(list(row))
            if len(rows) >= 5000:
                break
        parts.extend(markdown_table(rows) or ["(empty sheet)"])
    return "\n\n".join(parts)


def read_pdf(path):
    from pypdf import PdfReader

    reader = PdfReader(path)
    parts = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        if text:
            parts.append("## Page %d\n\n%s" % (index, text))
    return "\n\n".join(parts)


READERS = {"docx": read_docx, "xlsx": read_xlsx, "pdf": read_pdf}


def handler(request):
    kind = request.get("kind")
    if kind not in READERS:
        fail("unsupported_document")
    path = local_path(request, "input")
    text = READERS[kind](path)
    text = truncate(text.strip())
    if not text:
        fail("empty_document")
    emit({"ok": True, "text": text})


run(handler)
