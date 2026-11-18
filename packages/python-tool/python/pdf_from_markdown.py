"""pdf_from_markdown: Markdown to a selectable-text PDF, no network.

Text is set in DejaVu (installed in the agent image as the Alpine package
`font-dejavu`), registered with reportlab and embedded as a subset, so German
umlauts, Greek and Cyrillic survive in the PDF's text layer. A development
machine without the package falls back to the Base-14 Helvetica/Courier set;
that path is tested too. Nothing is downloaded or fetched at render time.
"""

import io
import os

from reportlab import rl_config
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

from _common import emit, run
from xml.sax.saxutils import escape

# Fixed producer, creation date and document id: identical input gives
# identical bytes, which makes the opt-in reproducibility check meaningful.
rl_config.invariant = 1

MEDIA_TYPE = "application/pdf"
DEFAULT_FONT_DIR = "/usr/share/fonts/dejavu"
FONT_DIR_ENV = "OPENCHAT_FONT_DIR"

# Family -> {registered PostScript name: file}. reportlab's `ps2tt` resolves a
# family by suffix, so the normal face must carry the bare family name.
FONT_FILES = {
    "DejaVu": {
        "DejaVu": "DejaVuSans.ttf",
        "DejaVu-Bold": "DejaVuSans-Bold.ttf",
        "DejaVu-Italic": "DejaVuSans-Oblique.ttf",
        "DejaVu-BoldItalic": "DejaVuSans-BoldOblique.ttf",
    },
    "DejaVuMono": {
        "DejaVuMono": "DejaVuSansMono.ttf",
        "DejaVuMono-Bold": "DejaVuSansMono-Bold.ttf",
        "DejaVuMono-Italic": "DejaVuSansMono-Oblique.ttf",
        "DejaVuMono-BoldItalic": "DejaVuSansMono-BoldOblique.ttf",
    },
}

BASE14 = {
    "embedded": False,
    "body": "Helvetica",
    "bold": "Helvetica-Bold",
    "mono": "Courier",
    "monoBold": "Courier-Bold",
}


def font_directory(directory: str | None = None) -> str:
    if directory is not None:
        return directory
    return os.environ.get(FONT_DIR_ENV) or DEFAULT_FONT_DIR


def font_set(directory: str | None = None) -> dict:
    """Register DejaVu and return the style font names, or the Base-14 fallback.

    All four faces of both families must be present; a half-installed family
    would silently lose bold text, so the fallback is chosen instead.
    """
    base = font_directory(directory)
    try:
        paths = {
            family: {name: os.path.join(base, filename) for name, filename in faces.items()}
            for family, faces in FONT_FILES.items()
        }
        if not all(
            os.path.isfile(path) for faces in paths.values() for path in faces.values()
        ):
            return dict(BASE14)

        for family, faces in paths.items():
            for name, path in faces.items():
                pdfmetrics.registerFont(TTFont(name, path))
            pdfmetrics.registerFontFamily(
                family,
                normal=family,
                bold=f"{family}-Bold",
                italic=f"{family}-Italic",
                boldItalic=f"{family}-BoldItalic",
            )
        return {
            "embedded": True,
            "body": "DejaVu",
            "bold": "DejaVu-Bold",
            "mono": "DejaVuMono",
            "monoBold": "DejaVuMono-Bold",
        }
    except Exception:
        # A damaged or partially installed font package must never break a
        # document; the ASCII-safe fallback still renders.
        return dict(BASE14)


def inline(text: str) -> str:
    escaped = escape(text)
    # A deliberately small subset: bold, italic and inline code. Links keep
    # their text and drop the target; the renderer never fetches a URL.
    escaped = escaped.replace("`", "")
    escaped = escaped.replace("**", "<b>", 1)
    while "**" in escaped:
        escaped = escaped.replace("**", "</b>", 1)
        if "**" in escaped:
            escaped = escaped.replace("**", "<b>", 1)
    if "<b>" in escaped and "</b>" not in escaped:
        escaped += "</b>"
    return escaped


def build_story(markdown: str, fonts: dict) -> list:
    body = ParagraphStyle(
        "Body",
        fontName=fonts["body"],
        fontSize=10.5,
        leading=15,
        spaceAfter=6,
    )
    headings = {
        1: ParagraphStyle("H1", parent=body, fontName=fonts["bold"], fontSize=18, leading=22),
        2: ParagraphStyle("H2", parent=body, fontName=fonts["bold"], fontSize=15, leading=19),
        3: ParagraphStyle("H3", parent=body, fontName=fonts["bold"], fontSize=12.5, leading=16),
    }
    code = ParagraphStyle("Code", parent=body, fontName=fonts["mono"], fontSize=8.5, leading=11)
    story: list = []
    in_code = False
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            story.append(Paragraph(escape(line).replace(" ", "&nbsp;") or "&nbsp;", code))
            continue
        if not line.strip():
            story.append(Spacer(1, 4))
            continue
        level = 0
        while level < len(line) and line[level] == "#":
            level += 1
        if 1 <= level <= 3 and line[level : level + 1] == " ":
            story.append(Paragraph(inline(line[level + 1 :].strip()), headings[level]))
            continue
        if line.lstrip().startswith(("- ", "* ")):
            story.append(Paragraph("&bull; " + inline(line.lstrip()[2:].strip()), body))
            continue
        story.append(Paragraph(inline(line.strip()), body))
    return story


def pdf_bytes(payload: dict, fonts: dict | None = None) -> bytes:
    markdown = payload.get("markdown")
    if not isinstance(markdown, str):
        markdown = ""
    selected = fonts if fonts is not None else font_set()
    output = io.BytesIO()
    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=str(payload.get("title") or "Document"),
        author="OpenChat",
    )
    document.build(build_story(markdown, selected))
    return output.getvalue()


def main(payload: dict) -> None:
    emit(str(payload["filename"]), MEDIA_TYPE, pdf_bytes(payload))


if __name__ == "__main__":
    run(main)
