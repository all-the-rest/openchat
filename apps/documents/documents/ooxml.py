"""OOXML package inspection and the .dotx -> .docx content-type rewrite.

A .dotx differs from a .docx only in the declared content type of its main
part. python-docx and docxtpl reject the template type, so we rewrite that one
string in a throwaway copy of the zip. The original bytes are never changed.
Macro-enabled packages are rejected by content type and by the presence of a
vbaProject.bin part, never by file extension.
"""

from __future__ import annotations

import io
import zipfile
import xml.etree.ElementTree as ET

from .errors import DocumentError
from .limits import MAX_ZIP_ENTRIES

CONTENT_TYPES = "[Content_Types].xml"
WORD_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
WORD_TEMPLATE = "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"
MACRO_DOC = "application/vnd.ms-word.document.macroEnabled.main+xml"
MACRO_TEMPLATE = "application/vnd.ms-word.template.macroEnabled.main+xml"
MACRO_TYPES = frozenset({MACRO_DOC, MACRO_TEMPLATE})
MACRO_PART = "vbaproject.bin"


def _open(data: bytes) -> tuple[list[str], bytes]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if len(names) > MAX_ZIP_ENTRIES:
                raise DocumentError("too_large")
            if CONTENT_TYPES not in names:
                raise DocumentError("invalid_template")
            raw = archive.read(CONTENT_TYPES)
    except DocumentError:
        raise
    except (zipfile.BadZipFile, KeyError, OSError, RuntimeError, ValueError):
        raise DocumentError("invalid_template")
    return names, raw


def classify(data: bytes) -> str:
    """Return 'docx', 'dotx', 'macro' or raise invalid_template."""
    names, raw = _open(data)
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raise DocumentError("invalid_template")
    types = {
        element.get("ContentType")
        for element in root.iter()
        if element.tag.endswith("Override")
    }
    if any(name.lower().endswith(MACRO_PART) for name in names):
        return "macro"
    if types & MACRO_TYPES:
        return "macro"
    if WORD_MAIN in types:
        return "docx"
    if WORD_TEMPLATE in types:
        return "dotx"
    raise DocumentError("invalid_template")


def normalise(data: bytes) -> bytes:
    """Return renderable DOCX bytes; reject macros and unknown packages."""
    kind = classify(data)
    if kind == "macro":
        raise DocumentError("macro_document")
    if kind == "docx":
        return data
    output = io.BytesIO()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            with zipfile.ZipFile(output, "w") as target:
                for info in source.infolist():
                    payload = source.read(info.filename)
                    if info.filename == CONTENT_TYPES:
                        text = payload.decode("utf-8")
                        if WORD_TEMPLATE not in text:
                            raise DocumentError("invalid_template")
                        payload = text.replace(WORD_TEMPLATE, WORD_MAIN).encode("utf-8")
                    target.writestr(info, payload)
    except DocumentError:
        raise
    except (zipfile.BadZipFile, OSError, RuntimeError, ValueError, UnicodeError):
        raise DocumentError("invalid_template")
    return output.getvalue()
