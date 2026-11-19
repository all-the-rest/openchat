"""Build-time smoke test for the document toolchain.

Run with `python3 python-smoke.py <directory-with-the-tool-scripts>` inside the
image and with the network disabled. It creates real DOCX, XLSX, PPTX and PDF
fixtures, proves markitdown converts all four without any download, proves
`read_document.py` returns Markdown for DOCX and XLSX, proves a corrupt DOCX
produces the stable `parse_failed` code with no traceback, proves the ZIP
tools list and extract with the stdlib reader only, proves
`docx_from_text.py` builds the same bytes twice, and proves the PDF text layer
keeps German umlauts, Greek and Cyrillic through the embedded DejaVu subset.

The PDF text layer is read with pdfminer.six (already installed for
markitdown). The unit tests use pypdf, which is a development-only pin; this
build step must not add a package the runtime does not need.
"""

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import zipfile

from docx import Document
from openpyxl import Workbook
from pdfminer.high_level import extract_text
from pptx import Presentation
from reportlab.pdfgen import canvas

EXPECTED = {
    "docx": "Smoke paragraph",
    "xlsx": "Coffee",
    "pptx": "Smoke deck",
    "pdf": "Smoke PDF",
}

DOCX_BLOCKS = [
    {"kind": "heading", "level": 1, "text": "Grüße"},
    {"kind": "paragraph", "text": "Offline body"},
    {"kind": "bullet", "text": "Point"},
    {"kind": "code", "text": "first\nsecond"},
    {"kind": "table", "rows": [["Item", "Amount"], ["Coffee", "4.5"]]},
]

FONT_SAMPLES = ("Grüße", "Ω", "Привет")


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


def run_tool(scripts: str, name: str, payload: dict) -> dict:
    result = subprocess.run(
        [sys.executable, os.path.join(scripts, name)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"{name} exited {result.returncode}")
    body = json.loads(result.stdout)
    if body.get("ok") is not True:
        raise SystemExit(f"{name} answered {body.get('code')}")
    return body


def docx_from_text(scripts: str) -> None:
    payload = {"filename": "Smoke.docx", "title": "Smoke", "blocks": DOCX_BLOCKS}
    first = run_tool(scripts, "docx_from_text.py", payload)
    second = run_tool(scripts, "docx_from_text.py", payload)
    if first["data"] != second["data"]:
        raise SystemExit("docx_from_text is not reproducible")

    document = Document(io.BytesIO(base64.b64decode(first["data"])))
    title = document.paragraphs[0]
    if title.text != "Smoke" or title.style.name != "Title":
        raise SystemExit("docx_from_text lost its title paragraph")
    styles = [paragraph.style.name for paragraph in document.paragraphs]
    if styles[1:] != ["Heading 1", "Normal", "List Bullet", "Code"]:
        raise SystemExit(f"docx_from_text styles are {styles}")
    table = document.tables[0]
    if [cell.text for cell in table.rows[1].cells] != ["Coffee", "4.5"]:
        raise SystemExit("docx_from_text lost its table cells")


def pdf_fonts(scripts: str) -> None:
    payload = {
        "filename": "Schriften.pdf",
        "title": "Schriften",
        "markdown": "# Schriften\n\n" + " — ".join(FONT_SAMPLES) + "\n",
    }
    body = run_tool(scripts, "pdf_from_markdown.py", payload)
    data = base64.b64decode(body["data"])
    if b"DejaVuSans" not in data:
        raise SystemExit("pdf_from_markdown did not embed the DejaVu family")
    text = extract_text(io.BytesIO(data))
    for sample in FONT_SAMPLES:
        if sample not in text:
            raise SystemExit(f"PDF text layer lost {sample!r}: {text!r}")


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


def archives(scripts: str, directory: str) -> None:
    archive = os.path.join(directory, "smoke.zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("notes/", "")
        package.writestr("notes/readme.txt", "archive smoke")

    listed = subprocess.run(
        [sys.executable, os.path.join(scripts, "archive_list.py")],
        input=json.dumps({"path": archive}),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if listed.returncode != 0:
        raise SystemExit("archive_list exited %s" % listed.returncode)
    body = json.loads(listed.stdout)
    if body.get("ok") is not True or body.get("totals", {}).get("entries") != 2:
        raise SystemExit("archive_list lost the fixture entries")

    destination = os.path.join(directory, "files")
    os.mkdir(destination)
    extracted = subprocess.run(
        [sys.executable, os.path.join(scripts, "archive_extract.py")],
        input=json.dumps(
            {
                "path": archive,
                "destination": destination,
                "directory": "bundle",
                "usedBytes": 0,
                "quotaBytes": 104857600,
                "maxFileBytes": 20971520,
            }
        ),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if extracted.returncode != 0:
        raise SystemExit("archive_extract exited %s" % extracted.returncode)
    written = os.path.join(destination, "bundle", "notes", "readme.txt")
    with open(written, encoding="utf-8") as handle:
        if handle.read() != "archive smoke":
            raise SystemExit("archive_extract lost the fixture bytes")


def main() -> None:
    scripts = sys.argv[1] if len(sys.argv) > 1 else "/opt/artifact-tool/packages/python-tool/python"
    with tempfile.TemporaryDirectory() as directory:
        paths = fixtures(directory)
        markitdown(paths)
        read_document(os.path.join(scripts, "read_document.py"), paths["docx"])
        read_document(os.path.join(scripts, "read_document.py"), paths["xlsx"])
        corrupt_document(os.path.join(scripts, "read_document.py"))
        archives(scripts, directory)
        docx_from_text(scripts)
        pdf_fonts(scripts)
    print("offline document smoke ok")


if __name__ == "__main__":
    main()
