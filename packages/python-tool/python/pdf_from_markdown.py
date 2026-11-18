"""pdf_from_markdown: render Markdown as a selectable-text PDF with reportlab.

Built-in fonts only (Helvetica/Courier): no font download, no network. The
subset covers headings, paragraphs, bullet lists, fenced code, bold, italic and
inline code. Non-latin-1 glyphs need embedded fonts, which this slice does not
ship (issue #22).
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import emit, fail, local_path, run  # noqa: E402

from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.platypus import (  # noqa: E402
    ListFlowable,
    ListItem,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
)

HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def escape(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def inline(text):
    """Escape, then the three inline spans reportlab understands as markup."""
    text = LINK.sub(lambda match: "%s (%s)" % (match.group(1), match.group(2)), text)
    text = escape(text)
    text = re.sub(r"`([^`]+)`", r'<font face="Courier">\1</font>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", text)
    return text


def styles():
    base = getSampleStyleSheet()
    return {
        "title": base["Title"],
        "body": base["BodyText"],
        "bullet": ParagraphStyle("Bullet", parent=base["BodyText"], leftIndent=12),
        "code": ParagraphStyle(
            "CodeBlock", parent=base["BodyText"], fontName="Courier", fontSize=8, leading=10
        ),
        "headings": [base["Heading1"], base["Heading2"], base["Heading3"]],
    }


def flowables(markdown, sheet):
    flow = []
    bullets = []
    paragraph = []

    def flush_bullets():
        if not bullets:
            return
        items = [ListItem(Paragraph(inline(text), sheet["bullet"]), leftIndent=12) for text in bullets]
        flow.append(ListFlowable(items, bulletType="bullet", start="circle"))
        bullets.clear()

    def flush_paragraph():
        if not paragraph:
            return
        flow.append(Paragraph(inline(" ".join(paragraph)), sheet["body"]))
        paragraph.clear()

    def flush_all():
        flush_paragraph()
        flush_bullets()

    lines = markdown.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if stripped.startswith("```"):
            flush_all()
            index += 1
            code = []
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code.append(lines[index])
                index += 1
            index += 1
            flow.append(Preformatted("\n".join(code), sheet["code"]))
            continue

        if stripped == "":
            flush_all()
            flow.append(Spacer(1, 5))
            index += 1
            continue

        heading = HEADING.match(line)
        if heading:
            flush_all()
            level = min(len(heading.group(1)), 3) - 1
            flow.append(Paragraph(inline(heading.group(2)), sheet["headings"][level]))
            index += 1
            continue

        bullet = BULLET.match(line)
        if bullet:
            flush_paragraph()
            bullets.append(bullet.group(1))
            index += 1
            continue

        if stripped.startswith(">"):
            flush_all()
            flow.append(Paragraph(inline(stripped.lstrip("> ").strip()), sheet["bullet"]))
            index += 1
            continue

        paragraph.append(stripped)
        index += 1

    flush_all()
    if not flow:
        flow.append(Spacer(1, 1))
    return flow


def handler(request):
    markdown = request.get("markdown")
    title = request.get("title")
    if not isinstance(markdown, str) or not markdown.strip():
        fail("invalid_output")
    if not isinstance(title, str) or not title.strip():
        title = "Document"
    output = local_path(request, "output")

    sheet = styles()
    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=title,
        author="OpenChat",
        creator="openchat-documents",
    )
    story = [Paragraph(escape(title), sheet["title"]), Spacer(1, 8)]
    story.extend(flowables(markdown, sheet))
    document.build(story)

    if os.path.getsize(output) == 0:
        fail("crashed")
    emit({"ok": True, "file": os.path.basename(output)})


run(handler)
