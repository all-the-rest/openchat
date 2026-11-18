"""Font registration, subset embedding and the text layer of `pdf_from_markdown.py`.

The DejaVu cases need the image's `font-dejavu` package (or `OPENCHAT_FONT_DIR`
pointing at the same TTFs); they skip on a workstation without it. The
registration mechanics are proven hermetically with the Bitstream Vera faces
reportlab ships, and the fallback case runs everywhere.
"""

import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

try:
    import pypdf
    import reportlab

    import pdf_from_markdown as target

    AVAILABLE = True
except Exception:  # pragma: no cover - the skip below reports it
    AVAILABLE = False

REPORTLAB_FONTS = Path(reportlab.__file__).parent / "fonts" if AVAILABLE else Path()
SAMPLE = "Grüße — Ω — Привет"

DEJAVU_DIR = Path(
    (os.environ.get("OPENCHAT_FONT_DIR") or target.DEFAULT_FONT_DIR) if AVAILABLE else "."
)
DEJAVU_PRESENT = AVAILABLE and all(
    (DEJAVU_DIR / filename).is_file()
    for faces in target.FONT_FILES.values()
    for filename in faces.values()
)

# Bitstream Vera (reportlab's bundled faces) has the Latin-1 glyphs the
# mechanics test needs; the DejaVu cases cover Greek and Cyrillic.
VERA_FACES = {
    "DejaVuSans.ttf": "Vera.ttf",
    "DejaVuSans-Bold.ttf": "VeraBd.ttf",
    "DejaVuSans-Oblique.ttf": "VeraIt.ttf",
    "DejaVuSans-BoldOblique.ttf": "VeraBI.ttf",
    "DejaVuSansMono.ttf": "Vera.ttf",
    "DejaVuSansMono-Bold.ttf": "VeraBd.ttf",
    "DejaVuSansMono-Oblique.ttf": "VeraIt.ttf",
    "DejaVuSansMono-BoldOblique.ttf": "VeraBI.ttf",
}


def text_of(data: bytes) -> str:
    return pypdf.PdfReader(io.BytesIO(data)).pages[0].extract_text()


def fonts_of(data: bytes) -> list:
    page = pypdf.PdfReader(io.BytesIO(data)).pages[0]
    return [font.get_object() for font in page["/Resources"]["/Font"].values()]


def render(markdown: str, fonts: dict) -> bytes:
    return target.pdf_bytes({"filename": "notes.pdf", "title": "Notes", "markdown": markdown}, fonts)


@unittest.skipUnless(AVAILABLE, "reportlab or pypdf is not installed")
class TestFontSelection(unittest.TestCase):
    def test_a_complete_family_is_registered_and_embedded(self):
        with tempfile.TemporaryDirectory() as directory:
            for target_name, source in VERA_FACES.items():
                shutil.copy(REPORTLAB_FONTS / source, Path(directory) / target_name)
            fonts = target.font_set(directory)
            self.assertTrue(fonts["embedded"])
            self.assertEqual(fonts["body"], "DejaVu")

            data = render("Grüße aus München — 100 %", fonts)
            self.assertIn("Grüße aus München", text_of(data))
            embedded = [font for font in fonts_of(data) if font.get("/Subtype") == "/TrueType"]
            self.assertTrue(embedded)
            for font in embedded:
                self.assertTrue(str(font.get("/BaseFont")).startswith("/"))
                # "AAAAAA+DejaVuSans": the six-letter prefix marks a subset.
                self.assertIn("+", str(font.get("/BaseFont")))
                self.assertIn("/ToUnicode", font)

    def test_a_missing_font_directory_falls_back_to_base14(self):
        with tempfile.TemporaryDirectory() as directory:
            fonts = target.font_set(directory)
            self.assertFalse(fonts["embedded"])
            self.assertEqual(fonts["body"], "Helvetica")

            data = render("Grüße", fonts)
            self.assertIn("Grüße", text_of(data))
            subtypes = {font.get("/Subtype") for font in fonts_of(data)}
            self.assertEqual(subtypes, {"/Type1"})

    def test_a_partial_family_falls_back_instead_of_losing_bold(self):
        with tempfile.TemporaryDirectory() as directory:
            shutil.copy(REPORTLAB_FONTS / "Vera.ttf", Path(directory) / "DejaVuSans.ttf")
            fonts = target.font_set(directory)
            self.assertFalse(fonts["embedded"])
            self.assertEqual(fonts["bold"], "Helvetica-Bold")

    def test_the_directory_can_come_from_the_environment(self):
        with mock.patch.dict(os.environ, {target.FONT_DIR_ENV: "/custom/fonts"}):
            self.assertEqual(target.font_directory(), "/custom/fonts")
        with mock.patch.dict(os.environ, {target.FONT_DIR_ENV: ""}):
            self.assertEqual(target.font_directory(), target.DEFAULT_FONT_DIR)

    def test_bold_markup_resolves_within_the_registered_family(self):
        with tempfile.TemporaryDirectory() as directory:
            for target_name, source in VERA_FACES.items():
                shutil.copy(REPORTLAB_FONTS / source, Path(directory) / target_name)
            data = render("Hallo **Welt**", target.font_set(directory))
            self.assertIn("Hallo Welt", text_of(data))
            # The BaseFont is the face's own PostScript name, so count the two
            # embedded subsets (regular and bold) instead of matching a name.
            subsets = [
                str(font.get("/BaseFont"))
                for font in fonts_of(data)
                if "+" in str(font.get("/BaseFont"))
            ]
            self.assertGreaterEqual(len(subsets), 2)


@unittest.skipUnless(AVAILABLE, "reportlab or pypdf is not installed")
class TestDejaVuTextLayer(unittest.TestCase):
    def test_umlauts_greek_and_cyrillic_survive_as_extracted_text(self):
        if not DEJAVU_PRESENT:
            self.skipTest(f"no DejaVu family in {DEJAVU_DIR}")
        fonts = target.font_set(str(DEJAVU_DIR))
        data = render(f"# Ausblick\n\n{SAMPLE}\n", fonts)

        text = text_of(data)
        for sample in ("Grüße", "Ω", "Привет"):
            self.assertIn(sample, text)

        embedded = [font for font in fonts_of(data) if font.get("/Subtype") == "/TrueType"]
        self.assertGreaterEqual(len(embedded), 1)
        for font in embedded:
            self.assertIn("DejaVu", str(font.get("/BaseFont")))
            self.assertIn("/ToUnicode", font)

    def test_identical_input_gives_identical_bytes(self):
        if not DEJAVU_PRESENT:
            self.skipTest(f"no DejaVu family in {DEJAVU_DIR}")
        fonts = target.font_set(str(DEJAVU_DIR))
        self.assertEqual(render(SAMPLE, fonts), render(SAMPLE, fonts))


if __name__ == "__main__":
    unittest.main()
