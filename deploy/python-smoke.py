"""Build-time smoke test for the document toolchain.

Run with `python3 python-smoke.py <directory-with-the-tool-scripts>` inside the
image and with the network disabled. It creates real DOCX, XLSX, PPTX and PDF
fixtures, proves markitdown converts all four without any download, proves
`read_document.py` returns Markdown for DOCX and XLSX, and proves a corrupt
DOCX produces the stable `parse_failed` code with no traceback.
"""

import base64
import json
import os
import subprocess
import sys
import tempfile

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from reportlab.pdfgen import canvas

EXPECTED = {
    "docx": "Smoke paragraph",
    "xlsx": "Coffee",
    "pptx": "Smoke deck",
    "pdf": "Smoke PDF",
}


def fixtures(directory: str) -> dict[str, str]:
    paths: dict[str, str] = {}

    document = Document()
    document.add_paragraph(EXPECTED["docx"])
    paths["docx"] = os.path.join(directory, "fixture.docx")
    document.save(paths["docx"])

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Item", "Amount"])
    sheet.append([EXPECTED["xlsx"], 4.5])
    paths["xlsx"] = os.path.join(directory, "fixture.xlsx")
    workbook.save(paths["xlsx"])

    slides = Presentation()
    slide = slides.slides.add_slide(slides.slide_layouts[1])
    slide.shapes.title.text = EXPECTED["pptx"]
    paths["pptx"] = os.path.join(directory, "fixture.pptx")
    slides.save(paths["pptx"])

    pdf = canvas.Canvas(os.path.join(directory, "fixture.pdf"))
    pdf.drawString(72, 720, EXPECTED["pdf"])
    pdf.save()
    paths["pdf"] = os.path.join(directory, "fixture.pdf")

    return paths


def markitdown(paths: dict[str, str]) -> None:
    for extension, text in EXPECTED.items():
        result = subprocess.run(
            ["markitdown", paths[extension]],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit(f"markitdown {extension} exited {result.returncode}")
        if text not in result.stdout:
            raise SystemExit(f"markitdown {extension} lost {text!r}")


def read_document(script: str, path: str) -> None:
    with open(path, "rb") as handle:
        payload = {
            "filename": os.path.basename(path),
            "data": base64.b64encode(handle.read()).decode("ascii"),
        }
    result = subprocess.run(
        [sys.executable, script],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"read_document {path} exited {result.returncode}")
    body = json.loads(result.stdout)
    if body.get("ok") is not True:
        raise SystemExit(f"read_document {path} answered {body.get('code')}")
    text = base64.b64decode(body["data"]).decode("utf-8")
    expected = EXPECTED["docx" if path.endswith(".docx") else "xlsx"]
    if expected not in text:
        raise SystemExit(f"read_document {path} lost {expected!r}")


def corrupt_document(script: str) -> None:
    payload = {
        "filename": "broken.docx",
        "data": base64.b64encode(b"this is not an OOXML package").decode("ascii"),
    }
    result = subprocess.run(
        [sys.executable, script],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode == 0:
        raise SystemExit("read_document accepted a corrupt DOCX")
    body = json.loads(result.stdout)
    if body.get("code") != "parse_failed":
        raise SystemExit(f"read_document mapped a corrupt file to {body.get('code')}")
    if "Traceback" in result.stderr:
        raise SystemExit("read_document leaked a traceback for a corrupt file")


def main() -> None:
    scripts = sys.argv[1] if len(sys.argv) > 1 else "/opt/artifact-tool/packages/python-tool/python"
    with tempfile.TemporaryDirectory() as directory:
        paths = fixtures(directory)
        markitdown(paths)
        read_document(os.path.join(scripts, "read_document.py"), paths["docx"])
        read_document(os.path.join(scripts, "read_document.py"), paths["xlsx"])
        corrupt_document(os.path.join(scripts, "read_document.py"))
    print("offline document smoke ok")


if __name__ == "__main__":
    main()
