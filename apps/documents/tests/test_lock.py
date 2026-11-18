"""The requirements lock stays fully pinned and reproducible."""

from __future__ import annotations

import os
import re

import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = os.path.join(ROOT, "requirements.lock")
LINE = re.compile(r"^[a-z0-9][a-z0-9._-]*==[A-Za-z0-9][A-Za-z0-9._+!-]*$")


class TestLock(unittest.TestCase):
    def test_every_dependency_line_is_pinned(self) -> None:
        with open(LOCK, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
        packages = [line for line in lines if line and not line.startswith("#")]
        self.assertGreaterEqual(len(packages), 8)
        for line in packages:
            self.assertRegex(line, LINE, line)
        names = [line.split("==", 1)[0] for line in packages]
        self.assertEqual(len(names), len(set(names)), "duplicate package in lock")
        for required in ("docxtpl", "python-docx", "pypdf", "pillow"):
            self.assertIn(required, names)

    def test_markitdown_stays_in_the_alpine_agent_image(self) -> None:
        with open(LOCK, encoding="utf-8") as handle:
            packages = [
                line
                for line in handle.read().splitlines()
                if line and not line.startswith("#")
            ]
        for line in packages:
            self.assertNotIn("markitdown", line)
            self.assertNotIn("onnxruntime", line)
            self.assertNotIn("numpy", line)

    def test_no_index_or_vcs_references(self) -> None:
        with open(LOCK, encoding="utf-8") as handle:
            text = handle.read()
        self.assertNotIn("--index-url", text)
        self.assertNotIn("git+", text)
        self.assertNotIn(" @ ", text)


if __name__ == "__main__":
    unittest.main()
