"""OOXML classification, the .dotx rewrite and the macro guard."""

from __future__ import annotations

import io
import unittest
import zipfile

from documents.errors import DocumentError
from documents.ooxml import CONTENT_TYPES, MACRO_TEMPLATE, WORD_MAIN, WORD_TEMPLATE


def package(content_type: str, macro: bool = False) -> bytes:
    types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        f'<Override PartName="/word/document.xml" ContentType="{content_type}"/>'
        "</Types>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(CONTENT_TYPES, types)
        archive.writestr("word/document.xml", "<w:document/>")
        if macro:
            archive.writestr("word/vbaProject.bin", b"MZ")
    return buffer.getvalue()


class TestOoxml(unittest.TestCase):
    def test_classifies_docx_and_dotx(self) -> None:
        from documents.ooxml import classify

        self.assertEqual(classify(package(WORD_MAIN)), "docx")
        self.assertEqual(classify(package(WORD_TEMPLATE)), "dotx")

    def test_macro_is_detected_by_part_and_content_type(self) -> None:
        from documents.ooxml import classify, normalise

        for data in (package(WORD_MAIN, macro=True), package(MACRO_TEMPLATE)):
            self.assertEqual(classify(data), "macro")
            with self.assertRaises(DocumentError) as caught:
                normalise(data)
            self.assertEqual(caught.exception.code, "macro_document")

    def test_dotx_rewrite_changes_only_the_content_type(self) -> None:
        from documents.ooxml import classify, normalise

        source = package(WORD_TEMPLATE)
        result = normalise(source)
        self.assertEqual(classify(result), "docx")
        self.assertNotEqual(source, result)
        with zipfile.ZipFile(io.BytesIO(result)) as archive:
            self.assertEqual(archive.namelist(), [CONTENT_TYPES, "word/document.xml"])
            self.assertEqual(archive.read("word/document.xml"), b"<w:document/>")
            self.assertIn(WORD_MAIN.encode(), archive.read(CONTENT_TYPES))
        # The original is untouched.
        self.assertIn(WORD_TEMPLATE.encode(), source)

    def test_docx_passes_through_byte_for_byte(self) -> None:
        from documents.ooxml import normalise

        source = package(WORD_MAIN)
        self.assertEqual(normalise(source), source)

    def test_bad_packages_are_invalid_template(self) -> None:
        from documents.ooxml import classify, normalise

        for data in (b"not a zip", b"", package("application/unknown")):
            for call in (classify, normalise):
                with self.assertRaises(DocumentError) as caught:
                    call(data)
                self.assertEqual(caught.exception.code, "invalid_template")
        empty = io.BytesIO()
        with zipfile.ZipFile(empty, "w") as archive:
            archive.writestr("hello.txt", "x")
        with self.assertRaises(DocumentError) as caught:
            classify(empty.getvalue())
        self.assertEqual(caught.exception.code, "invalid_template")


if __name__ == "__main__":
    unittest.main()
