"""docx_fill: build a Word document or fill a template's `{{placeholders}}`."""

import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import emit, fail, local_path, run  # noqa: E402

from docx import Document  # noqa: E402

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}")


def _replace_paragraph(paragraph, values):
    original = paragraph.text
    if "{{" not in original:
        return
    replaced = PLACEHOLDER.sub(lambda match: values.get(match.group(1), match.group(0)), original)
    if replaced == original:
        return
    runs = paragraph.runs
    if not runs:
        paragraph.add_run(replaced)
        return
    # A placeholder that spans runs cannot be replaced run-by-run. Keeping the
    # paragraph style and putting the filled text in the first run is the
    # documented trade-off (per-run styling inside a filled paragraph is lost).
    runs[0].text = replaced
    for run in runs[1:]:
        run.text = ""


def _replace_table(table, values):
    for row in table.rows:
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                _replace_paragraph(paragraph, values)
            for nested in cell.tables:
                _replace_table(nested, values)


def _replace_container(container, values):
    for paragraph in container.paragraphs:
        _replace_paragraph(paragraph, values)
    for table in container.tables:
        _replace_table(table, values)


def handler(request):
    values = request.get("values") or {}
    if not isinstance(values, dict):
        fail("invalid_output")
    output = local_path(request, "output")

    if request.get("input"):
        template_path = local_path(request, "input")
        with zipfile.ZipFile(template_path) as archive:
            if any(name.endswith("vbaProject.bin") for name in archive.namelist()):
                fail("macro_document")
        document = Document(template_path)
        _replace_container(document, values)
        for section in document.sections:
            for part in (
                section.header,
                section.footer,
                section.first_page_header,
                section.first_page_footer,
                section.even_page_header,
                section.even_page_footer,
            ):
                _replace_container(part, values)
    else:
        document = Document()
        title = request.get("title")
        if isinstance(title, str) and title.strip():
            document.add_heading(title.strip(), level=0)
        paragraphs = request.get("paragraphs") or []
        if not isinstance(paragraphs, list):
            fail("invalid_output")
        for entry in paragraphs:
            if not isinstance(entry, str):
                fail("invalid_output")
            document.add_paragraph(entry)
        if not paragraphs and not (isinstance(title, str) and title.strip()):
            fail("crashed")

    document.save(output)
    if os.path.getsize(output) == 0:
        fail("crashed")
    emit({"ok": True, "file": os.path.basename(output)})


run(handler)
