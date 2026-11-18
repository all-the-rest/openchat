"""Unit tests for `docx_from_text.py`: block kinds, page setup, caps, determinism.

Run from this directory or through `pnpm --filter @openchat/python-tool test`,
which skips the module when python-docx is not installed (CI has no Python
toolchain; the image smoke test covers the same script with the real image).
"""

import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

try:
    import docx

    import docx_from_text as target

    AVAILABLE = True
except Exception:  # pragma: no cover - the skip below reports it
    AVAILABLE = False

BLOCKS = [
    {"kind": "heading", "level": 1, "text": "Report"},
    {"kind": "paragraph", "text": "Hello"},
]


def code_of(callback) -> str:
    """The stable error code `fail()` printed, without the SystemExit."""
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        try:
            callback()
        except SystemExit:
            pass
        else:
            raise AssertionError("expected the script to refuse the request")
    return json.loads(buffer.getvalue())["code"]


def build(blocks, title=None) -> bytes:
    document = target.build_document(target.normalise(blocks), title)
    output = io.BytesIO()
    document.save(output)
    return target.finalize(output.getvalue())


def opened(data: bytes):
    return docx.Document(io.BytesIO(data))


def styles_of(document) -> list:
    return [paragraph.style.name for paragraph in document.paragraphs]


@unittest.skipUnless(AVAILABLE, "python-docx is not installed")
class TestBlockKinds(unittest.TestCase):
    def test_heading_levels_use_heading_styles(self):
        data = build(
            [
                {"kind": "heading", "level": 1, "text": "One"},
                {"kind": "heading", "level": 2, "text": "Two"},
                {"kind": "heading", "level": 3, "text": "Three"},
            ]
        )
        self.assertEqual(styles_of(opened(data)), ["Heading 1", "Heading 2", "Heading 3"])

    def test_paragraph_bullet_and_code_styles(self):
        data = build(
            [
                {"kind": "paragraph", "text": "Body"},
                {"kind": "bullet", "text": "Point"},
                {"kind": "code", "text": "first\nsecond"},
            ]
        )
        document = opened(data)
        self.assertEqual(styles_of(document), ["Normal", "List Bullet", "Code"])
        code = document.paragraphs[2]
        self.assertEqual(code.text, "first\nsecond")
        self.assertEqual(code.style.font.name, "Courier New")
        # One run with an explicit line break between the two code lines.
        self.assertEqual(len(code.runs), 1)
        self.assertIn("<w:br/>", code._p.xml)

    def test_table_has_a_grid_and_a_bold_header_row(self):
        data = build(
            [
                {
                    "kind": "table",
                    "rows": [["Item", "Amount"], ["Coffee", "4.5"]],
                }
            ]
        )
        document = opened(data)
        table = document.tables[0]
        self.assertEqual(table.style.name, "Table Grid")
        self.assertEqual([cell.text for cell in table.rows[0].cells], ["Item", "Amount"])
        self.assertEqual([cell.text for cell in table.rows[1].cells], ["Coffee", "4.5"])
        for cell in table.rows[0].cells:
            self.assertTrue(all(run.bold for run in cell.paragraphs[0].runs))
        for cell in table.rows[1].cells:
            self.assertFalse(any(run.bold for run in cell.paragraphs[0].runs))

    def test_title_is_a_title_paragraph_only_when_asked_for(self):
        with_title = opened(build(BLOCKS, "Report"))
        self.assertEqual(styles_of(with_title)[0], "Title")
        without = opened(build(BLOCKS))
        self.assertEqual(styles_of(without), ["Heading 1", "Normal"])


@unittest.skipUnless(AVAILABLE, "python-docx is not installed")
class TestPageAndProperties(unittest.TestCase):
    def test_a4_page_with_two_centimetre_margins(self):
        section = opened(build(BLOCKS)).sections[0]
        self.assertAlmostEqual(section.page_width.cm, 21, places=1)
        self.assertAlmostEqual(section.page_height.cm, 29.7, places=1)
        for margin in (
            section.top_margin,
            section.bottom_margin,
            section.left_margin,
            section.right_margin,
        ):
            self.assertAlmostEqual(margin.cm, 2, places=1)


@unittest.skipUnless(AVAILABLE, "python-docx is not installed")
class TestDeterminism(unittest.TestCase):
    def test_two_runs_are_byte_identical(self):
        self.assertEqual(build(BLOCKS, "Report"), build(BLOCKS, "Report"))

    def test_every_zip_entry_has_a_fixed_timestamp(self):
        archive = zipfile.ZipFile(io.BytesIO(build(BLOCKS)))
        self.assertTrue(archive.namelist())
        self.assertEqual({info.date_time for info in archive.infolist()}, {target.ZIP_TIME})

    def test_core_properties_are_fixed(self):
        properties = opened(build(BLOCKS, "Report")).core_properties
        # python-docx returns the timestamps as UTC-aware datetimes.
        self.assertEqual(properties.created.replace(tzinfo=None), target.FIXED_TIME)
        self.assertEqual(properties.modified.replace(tzinfo=None), target.FIXED_TIME)
        self.assertEqual(properties.author, "OpenChat")
        self.assertEqual(properties.last_modified_by, "OpenChat")
        self.assertEqual(properties.revision, 1)
        self.assertEqual(properties.comments, "")


@unittest.skipUnless(AVAILABLE, "python-docx is not installed")
class TestCaps(unittest.TestCase):
    def test_more_than_500_blocks(self):
        blocks = [dict(BLOCKS[1]) for _ in range(target.MAX_BLOCKS + 1)]
        self.assertEqual(code_of(lambda: target.normalise(blocks)), "too_many")

    def test_more_than_20000_characters(self):
        blocks = [
            {"kind": "paragraph", "text": "a" * (target.MAX_TEXT_CHARS // 2 + 1)},
            {"kind": "paragraph", "text": "a" * (target.MAX_TEXT_CHARS // 2 + 1)},
        ]
        self.assertEqual(code_of(lambda: target.normalise(blocks)), "too_many")

    def test_table_row_and_column_caps(self):
        rows = [["a"]] * (target.MAX_TABLE_ROWS + 1)
        self.assertEqual(
            code_of(lambda: target.normalise([{"kind": "table", "rows": rows}])), "too_many"
        )
        wide = [["a"] * (target.MAX_TABLE_COLUMNS + 1)]
        self.assertEqual(
            code_of(lambda: target.normalise([{"kind": "table", "rows": wide}])), "too_many"
        )

    def test_output_cap_is_checked_before_the_zip_is_rewritten(self):
        oversized = b"x" * (target.MAX_DOCX_BYTES + 1)
        self.assertEqual(code_of(lambda: target.finalize(oversized)), "too_large")

    def test_malformed_blocks_are_invalid_input(self):
        cases = [
            [],
            [{"kind": "image", "text": "x"}],
            [{"kind": "paragraph"}],
            [{"kind": "paragraph", "text": "a\nb"}],
            [{"kind": "paragraph", "text": "a\u0000b"}],
            [{"kind": "heading", "level": 4, "text": "x"}],
            [{"kind": "heading", "level": True, "text": "x"}],
            [{"kind": "table", "rows": [["a", "b"], ["c"]]}],
            [{"kind": "table", "rows": []}],
        ]
        for blocks in cases:
            with self.subTest(blocks=blocks):
                self.assertEqual(code_of(lambda: target.normalise(blocks)), "invalid_input")

    def test_code_blocks_keep_line_breaks(self):
        normalised = target.normalise([{"kind": "code", "text": "a\nb"}])
        self.assertEqual(normalised[0]["text"], "a\nb")


@unittest.skipUnless(AVAILABLE, "python-docx is not installed")
class TestScriptContract(unittest.TestCase):
    def run_script(self, payload: dict) -> dict:
        result = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "docx_from_text.py")],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("Traceback", result.stderr)
        return json.loads(result.stdout)

    def test_one_json_document_on_stdout_and_identical_bytes_on_a_second_run(self):
        payload = {"filename": "Report.docx", "title": "Report", "blocks": BLOCKS}
        first = self.run_script(payload)
        second = self.run_script(payload)
        self.assertIs(first["ok"], True)
        self.assertEqual(first["filename"], "Report.docx")
        self.assertEqual(first["mediaType"], target.MEDIA_TYPE)
        self.assertEqual(first["data"], second["data"])
        data = base64.b64decode(first["data"])
        self.assertEqual(styles_of(opened(data))[0], "Title")

    def test_a_rejected_request_answers_one_code_and_no_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(SCRIPT_DIR / "docx_from_text.py")],
                input=json.dumps({"filename": "x.docx", "blocks": [{"kind": "table"}]}),
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
                cwd=directory,
            )
        self.assertNotEqual(result.returncode, 0)
        body = json.loads(result.stdout)
        self.assertEqual(body, {"ok": False, "code": "invalid_input"})
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
