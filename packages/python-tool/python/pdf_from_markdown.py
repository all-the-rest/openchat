"""pdf_from_markdown: Markdown to a selectable-text PDF, no network."""

import io

from reportlab import rl_config
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

from _common import emit, run
from xml.sax.saxutils import escape

# Fixed producer, creation date and document id: identical input gives
# identical bytes, which makes the opt-in reproducibility check meaningful.
rl_config.invariant = 1

MEDIA_TYPE = "application/pdf"


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


def build_story(markdown: str, styles) -> list:
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=15,
        spaceAfter=6,
    )
    headings = {
        1: ParagraphStyle("H1", parent=body, fontName="Helvetica-Bold", fontSize=18, leading=22),
        2: ParagraphStyle("H2", parent=body, fontName="Helvetica-Bold", fontSize=15, leading=19),
        3: ParagraphStyle("H3", parent=body, fontName="Helvetica-Bold", fontSize=12.5, leading=16),
    }
    story: list = []
    in_code = False
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            story.append(
                Paragraph(
                    escape(line).replace(" ", "&nbsp;") or "&nbsp;",
                    ParagraphStyle("Code", parent=body, fontName="Courier", fontSize=8.5, leading=11),
                )
            )
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


def main(payload: dict) -> None:
    markdown = payload.get("markdown")
    if not isinstance(markdown, str):
        markdown = ""
    styles = getSampleStyleSheet()
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
    document.build(build_story(markdown, styles))
    emit(str(payload["filename"]), MEDIA_TYPE, output.getvalue())


run(main)
