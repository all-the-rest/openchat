"""docx_fill: create or fill a DOCX from a JSON request."""

import io

from docx import Document

from _common import decode_payload, emit, fail, run

MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def replace_text(text: str, values: dict) -> str:
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def replace_paragraph(paragraph, values: dict) -> None:
    text = "".join(run.text for run in paragraph.runs)
    if "{{" not in text:
        return
    replaced = replace_text(text, values)
    if replaced == text:
        return
    if paragraph.runs:
        paragraph.runs[0].text = replaced
        for extra in paragraph.runs[1:]:
            extra.text = ""
    else:
        paragraph.add_run(replaced)


def replace_container(container, values: dict) -> None:
    for paragraph in container.paragraphs:
        replace_paragraph(paragraph, values)
    for table in getattr(container, "tables", []):
        for row in table.rows:
            for cell in row.cells:
                replace_container(cell, values)


def build(payload: dict) -> Document:
    template = payload.get("template")
    if template is not None:
        raw = decode_payload(template)
        if len(raw) > 1024 * 1024:
            fail("too_large")
        return Document(io.BytesIO(raw))

    document = Document()
    for text in payload.get("paragraphs", []):
        document.add_paragraph(str(text))
    return document


def main(payload: dict) -> None:
    values = payload.get("values") or {}
    if not isinstance(values, dict):
        fail("invalid_input")

    document = build(payload)
    replace_container(document, values)
    for section in document.sections:
        replace_container(section.header, values)
        replace_container(section.footer, values)

    output = io.BytesIO()
    document.save(output)
    emit(str(payload["filename"]), MEDIA_TYPE, output.getvalue())


run(main)
