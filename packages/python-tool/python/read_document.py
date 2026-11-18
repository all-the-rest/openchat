"""read_document: DOCX, XLSX, PPTX, PDF or text to Markdown via markitdown."""

import io
import os
import zipfile

from markitdown import MarkItDown, StreamInfo

from _common import decode_payload, emit, fail, run

MEDIA_TYPE = "text/markdown"
TEXT_EXTENSIONS = (".md", ".markdown", ".txt")
DOCUMENT_MIMETYPES = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pdf": "application/pdf",
}
# An OOXML package is a ZIP with one of these parts. Checking the container
# first turns a renamed text file into a stable `parse_failed` instead of
# letting markitdown's text fallback echo the bytes back as Markdown.
REQUIRED_PART = {
    ".docx": "word/document.xml",
    ".xlsx": "xl/workbook.xml",
    ".pptx": "ppt/presentation.xml",
}


def verify(data: bytes, extension: str) -> None:
    if extension == ".pdf":
        if not data.startswith(b"%PDF-"):
            fail("parse_failed")
        return
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = set(archive.namelist())
    except Exception:
        fail("parse_failed")
    if REQUIRED_PART[extension] not in names:
        fail("parse_failed")


def convert(data: bytes, extension: str) -> str:
    """One markitdown conversion; every failure becomes the same stable code."""
    try:
        result = MarkItDown(enable_plugins=False).convert_stream(
            io.BytesIO(data),
            stream_info=StreamInfo(
                extension=extension,
                mimetype=DOCUMENT_MIMETYPES[extension],
            ),
        )
    except Exception:
        fail("parse_failed")
    return str(result.markdown)


def main(payload: dict) -> None:
    name = str(payload.get("filename") or "")
    raw = decode_payload(str(payload.get("data") or ""))
    extension = os.path.splitext(name)[1].lower()

    if extension in TEXT_EXTENSIONS:
        text = raw.decode("utf-8", errors="replace")
    elif extension in DOCUMENT_MIMETYPES:
        verify(raw, extension)
        text = convert(raw, extension)
    else:
        fail("unsupported")

    if not text.strip():
        fail("parse_failed")

    stem = os.path.splitext(os.path.basename(name))[0] or "document"
    emit(f"{stem}.md", MEDIA_TYPE, text.encode("utf-8"))


run(main)
