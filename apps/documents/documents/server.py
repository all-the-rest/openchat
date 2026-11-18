"""Small bearer-authenticated HTTP service.

One job at a time, one throwaway directory per request, a body cap, and a
single stable error shape. Nothing here returns a Python or LibreOffice
traceback: unexpected exceptions are logged by type only and answered with a
fixed code.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from .convert import docx_to_pdf
from .errors import DocumentError, error_body
from .limits import (
    MAX_BODY_BYTES,
    MAX_KEY_CHARS,
    MAX_NAME_CHARS,
    MAX_TEMPLATE_BYTES,
    MAX_VALUES,
    MAX_VALUE_CHARS,
    REQUEST_TIMEOUT_SECONDS,
)
from .render import render_template

Render = Callable[[bytes, dict], bytes]
Convert = Callable[[bytes, str], bytes]

STATUS = {
    "invalid_template": 400,
    "bad_request": 400,
    "macro_document": 400,
    "too_large": 413,
    "unknown_placeholder": 422,
    "render_failed": 422,
    "convert_failed": 422,
    "timeout": 504,
    "unauthorized": 401,
    "not_found": 404,
}

KEY = re.compile(r"^[A-Za-z0-9_.-]{1," + str(MAX_KEY_CHARS) + r"}$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0," + str(MAX_NAME_CHARS - 1) + r"}$")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
ZIP_PREFIX = b"PK\x03\x04"


class Operations:
    """Injectable seams so the HTTP layer is testable without LibreOffice."""

    def __init__(
        self,
        render: Render | None = None,
        convert: Convert | None = None,
    ) -> None:
        self.render = render or render_template
        self.convert = convert or docx_to_pdf


class Service:
    def __init__(self, token: str, operations: Operations | None = None) -> None:
        self.token = token
        self.ops = operations or Operations()
        self.lock = threading.Lock()


def decode(value: object, field: str, maximum: int) -> bytes:
    if not isinstance(value, str) or not value:
        raise DocumentError("bad_request", field)
    encoded_cap = (maximum * 4) // 3 + 4
    if len(value) > encoded_cap:
        raise DocumentError("too_large")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise DocumentError("bad_request", field)
    if not raw or len(raw) > maximum:
        raise DocumentError("too_large")
    return raw


def _checked_value(node: object, depth: int = 0) -> object:
    """Allow scalars and simple lists/maps so `{% for %}` loops can be filled."""
    if depth > 4:
        raise DocumentError("bad_request", "values.depth")
    if node is None or isinstance(node, bool):
        return node
    if isinstance(node, (int, float)):
        if isinstance(node, float) and (node != node or node in (float("inf"), float("-inf"))):
            raise DocumentError("bad_request", "values.number")
        return node
    if isinstance(node, str):
        if CONTROL.search(node) or len(node) > MAX_VALUE_CHARS:
            raise DocumentError("bad_request", "values.string")
        return node
    if isinstance(node, list):
        if len(node) > 200:
            raise DocumentError("too_large")
        return [_checked_value(entry, depth + 1) for entry in node]
    if isinstance(node, dict):
        if len(node) > MAX_VALUES:
            raise DocumentError("too_large")
        result: dict = {}
        for key, entry in node.items():
            if not isinstance(key, str) or not KEY.match(key):
                raise DocumentError("bad_request", "values.key")
            result[key] = _checked_value(entry, depth + 1)
        return result
    raise DocumentError("bad_request", "values.type")


def values_map(value: object) -> dict:
    if value is None:
        return {}
    checked = _checked_value(value)
    if not isinstance(checked, dict):
        raise DocumentError("bad_request", "values")
    return checked


def output_name(value: object) -> str:
    if value is None:
        return "document"
    if not isinstance(value, str) or not NAME.match(value):
        raise DocumentError("bad_request", "name")
    return value


def make_handler(service: Service):
    """Build a request handler bound to one service instance."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "OpenChatDocuments/1"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: object) -> None:
            # No path, header or body is logged: a token could be in a header.
            return

        def reply(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            match = re.match(r"^Bearer\s+(\S+)\s*$", header, re.IGNORECASE)
            return bool(match and hmac.compare_digest(match.group(1), service.token))

        def body_bytes(self) -> bytes:
            raw_length = self.headers.get("Content-Length", "")
            if not raw_length.isdigit() or int(raw_length) > MAX_BODY_BYTES:
                raise DocumentError("too_large")
            chunks: list[bytes] = []
            total = 0
            while total < int(raw_length):
                chunk = self.rfile.read(min(65536, int(raw_length) - total))
                if not chunk:
                    raise DocumentError("bad_request")
                chunks.append(chunk)
                total += len(chunk)
            return b"".join(chunks)

        def request_json(self) -> dict:
            raw = self.body_bytes()
            try:
                parsed = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise DocumentError("bad_request")
            if not isinstance(parsed, dict):
                raise DocumentError("bad_request")
            return parsed

        def do_GET(self) -> None:
            if self.path.split("?", 1)[0] == "/healthz":
                self.reply(200, {"ok": True})
                return
            self.reply(404, error_body("not_found"))

        def do_POST(self) -> None:
            self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)
            if not self.authorized():
                self.reply(401, error_body("unauthorized"))
                return
            path = self.path.split("?", 1)[0]
            if path not in ("/fill", "/convert"):
                self.reply(404, error_body("not_found"))
                return
            try:
                request = self.request_json()
                with tempfile.TemporaryDirectory(prefix="openchat-documents-") as workdir:
                    with service.lock:
                        payload = dispatch(service, path, request, workdir)
                self.reply(200, payload)
            except DocumentError as error:
                self.reply(STATUS.get(error.code, 422), error.body())
            except Exception as error:  # noqa: BLE001 - boundary of untrusted input
                # Ops sees only the exception type, never a traceback or stderr.
                print(f"documents: {type(error).__name__}", file=sys.stderr, flush=True)
                self.reply(422, error_body("render_failed"))

    return Handler


def dispatch(service: Service, path: str, request: dict, workdir: str) -> dict:
    if path == "/fill":
        template = decode(request.get("template"), "template", MAX_TEMPLATE_BYTES)
        if not template.startswith(ZIP_PREFIX):
            raise DocumentError("invalid_template")
        values = values_map(request.get("values"))
        name = output_name(request.get("name"))
        docx = service.ops.render(template, values)
        pdf = service.ops.convert(docx, workdir)
        return {
            "docx": base64.b64encode(docx).decode("ascii"),
            "pdf": base64.b64encode(pdf).decode("ascii"),
            "docxName": f"{name}.docx",
            "pdfName": f"{name}.pdf",
        }

    if path == "/convert":
        document = decode(
            request.get("document", request.get("base64")), "document", MAX_TEMPLATE_BYTES
        )
        if not document.startswith(ZIP_PREFIX):
            raise DocumentError("invalid_template")
        name = output_name(request.get("name"))
        pdf = service.ops.convert(document, workdir)
        return {
            "pdf": base64.b64encode(pdf).decode("ascii"),
            "pdfName": f"{name}.pdf",
        }

    raise DocumentError("not_found")


def serve(token: str, port: int, operations: Operations | None = None) -> None:
    """Bind every interface on the internal network; no published port."""
    if not token:
        raise RuntimeError("DOCUMENTS_TOKEN must be set")
    service = Service(token, operations)
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(service))
    server.daemon_threads = True
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()


def main() -> None:
    token = os.environ.get("DOCUMENTS_TOKEN", "").strip()
    raw_port = os.environ.get("DOCUMENTS_PORT", "8099")
    if not raw_port.isdigit() or not (1 <= int(raw_port) <= 65535):
        raise RuntimeError("DOCUMENTS_PORT must be a valid port")
    serve(token, int(raw_port))


if __name__ == "__main__":
    main()
