"""Document -> Markdown through markitdown (the Debian-only dependency)."""

from __future__ import annotations

import io
import os
from typing import Callable

from .errors import DocumentError
from .limits import EXTRACT_EXTENSIONS, MAX_MARKDOWN_CHARS

Extractor = Callable[[bytes, str], str]


def extract_markdown(data: bytes, name: str, extractor: Extractor | None = None) -> str:
    """Return Markdown text for one uploaded document. No network is used."""
    extension = os.path.splitext(name)[1].lower()
    if extension not in EXTRACT_EXTENSIONS:
        raise DocumentError("unsupported_format")
    if not data:
        raise DocumentError("bad_request")

    if extractor is not None:
        try:
            text = extractor(data, extension)
        except DocumentError:
            raise
        except Exception:
            raise DocumentError("render_failed")
    else:
        try:
            from markitdown import MarkItDown

            converter = MarkItDown(enable_plugins=False)
            result = converter.convert_stream(io.BytesIO(data), file_extension=extension)
            text = result.text_content or ""
        except DocumentError:
            raise
        except Exception:
            raise DocumentError("render_failed")

    if not isinstance(text, str):
        raise DocumentError("render_failed")
    return text[:MAX_MARKDOWN_CHARS]
