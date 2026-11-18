"""Opt-in end-to-end round trip with a real .dotx and LibreOffice.

Run inside the documents image (where soffice and the pinned libraries exist):
    python -m unittest discover -s apps/documents/tests -p 'integration.py' -v
Every check skips when LibreOffice or a library is absent, so `gates:fast`
stays offline and fast.
"""

from __future__ import annotations

import io
import os
import shutil
import tempfile
import unittest

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
VALUES = {
    "customer": "Ada Lovelace",
    "date": "2026-11-18",
    "items": [
        {"name": "Analytical engine", "amount": "100"},
        {"name": "Punch cards", "amount": "25"},
    ],
    "total": "125",
}

HAS_LO = shutil.which("soffice") is not None
try:
    import docxtpl  # noqa: F401
    import docx  # noqa: F401
    import pypdf

    HAS_LIBS = True
except ImportError:
    HAS_LIBS = False


def fixture(name: str) -> bytes:
    with open(os.path.join(FIXTURES, name), "rb") as handle:
        return handle.read()


@unittest.skipUnless(HAS_LIBS, "pinned libraries not installed")
class TestTemplate(unittest.TestCase):
    def test_real_dotx_fills_and_macro_fixture_is_rejected(self) -> None:
        from documents.errors import DocumentError
        from documents.ooxml import classify, normalise
        from documents.render import render_template

        source = fixture("invoice.dotx")
        self.assertEqual(classify(source), "dotx")
        filled = render_template(source, VALUES)
        self.assertTrue(filled.startswith(b"PK\x03\x04"))
        with __import__("zipfile").ZipFile(io.BytesIO(filled)) as archive:
            xml = archive.read("word/document.xml").decode("utf-8")
        for expected in ("Ada Lovelace", "Analytical engine", "Punch cards", "125"):
            self.assertIn(expected, xml)

        with self.assertRaises(DocumentError) as caught:
            render_template(fixture("macro.docm"), VALUES)
        self.assertEqual(caught.exception.code, "macro_document")
        # normalise never mutates the original.
        self.assertEqual(classify(source), "dotx")

    def test_missing_placeholder_is_unknown_placeholder(self) -> None:
        from documents.errors import DocumentError
        from documents.render import render_template

        with self.assertRaises(DocumentError) as caught:
            render_template(fixture("invoice.dotx"), {"customer": "Ada"})
        self.assertEqual(caught.exception.code, "unknown_placeholder")


@unittest.skipUnless(HAS_LO and HAS_LIBS, "LibreOffice or libraries not installed")
class TestConversion(unittest.TestCase):
    def test_filled_docx_becomes_selectable_pdf(self) -> None:
        from documents.convert import docx_to_pdf
        from documents.render import render_template

        filled = render_template(fixture("invoice.dotx"), VALUES)
        with tempfile.TemporaryDirectory(prefix="openchat-documents-it-") as workdir:
            pdf = docx_to_pdf(filled, workdir)
            self.assertTrue(pdf.startswith(b"%PDF-"))
            reader = pypdf.PdfReader(io.BytesIO(pdf))
            self.assertGreaterEqual(len(reader.pages), 1)
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            for expected in ("Ada Lovelace", "Analytical engine", "Punch cards"):
                self.assertIn(expected, text)


if __name__ == "__main__":
    unittest.main()
