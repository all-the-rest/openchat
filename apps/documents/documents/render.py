"""Jinja placeholder rendering through docxtpl, with a strict undefined."""

from __future__ import annotations

import io
from typing import Callable

from .errors import DocumentError
from .limits import MAX_OUTPUT_BYTES
from .ooxml import normalise

Renderer = Callable[[bytes, dict], bytes]


def render_template(data: bytes, values: dict, renderer: Renderer | None = None) -> bytes:
    """Return the filled DOCX bytes. No macro template reaches the renderer."""
    document = normalise(data)
    if renderer is not None:
        try:
            result = renderer(document, values)
        except DocumentError:
            raise
        except Exception:
            raise DocumentError("render_failed")
    else:
        try:
            from docxtpl import DocxTemplate
            from jinja2 import Environment, StrictUndefined

            environment = Environment(undefined=StrictUndefined, autoescape=False)
            template = DocxTemplate(io.BytesIO(document))
            template.render(values, jinja_env=environment)
            buffer = io.BytesIO()
            template.save(buffer)
            result = buffer.getvalue()
        except DocumentError:
            raise
        except Exception as error:
            # A missing {{placeholder}} or loop variable is one stable code;
            # no jinja/library text is passed on.
            if type(error).__name__ == "UndefinedError":
                raise DocumentError("unknown_placeholder")
            raise DocumentError("render_failed")
    if not isinstance(result, (bytes, bytearray)) or len(result) == 0:
        raise DocumentError("render_failed")
    if len(result) > MAX_OUTPUT_BYTES:
        raise DocumentError("too_large")
    return bytes(result)
