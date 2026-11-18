"""Stable, one-line error codes. No library or LibreOffice text ever escapes."""

from __future__ import annotations

MESSAGES = {
    "invalid_template": "The template is not a readable DOCX or DOTX package",
    "unknown_placeholder": "The values do not cover every placeholder in the template",
    "render_failed": "The template could not be rendered",
    "convert_failed": "The rendered document could not be converted to PDF",
    "macro_document": "Macro-enabled documents are not supported",
    "too_large": "The document exceeds the size limit",
    "timeout": "The conversion ran longer than its limit and was stopped",
    "bad_request": "The request body is invalid",
    "unauthorized": "Authentication required",
    "not_found": "Unknown endpoint",
}


class DocumentError(Exception):
    """An error with a code the caller can switch on."""

    def __init__(self, code: str, detail: str | None = None) -> None:
        message = MESSAGES.get(code, MESSAGES["render_failed"])
        if detail:
            # The detail is a fixed hint from our own code, never stderr.
            message = f"{message} ({detail})"
        super().__init__(message)
        self.code = code if code in MESSAGES else "render_failed"

    def body(self) -> dict:
        return {"error": {"code": self.code, "message": str(self)}}


def error_body(code: str) -> dict:
    """Fixed body for a code; used for errors raised outside DocumentError."""
    return DocumentError(code).body()
