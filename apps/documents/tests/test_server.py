"""HTTP surface: auth, body cap, stable errors, cleanup, single job."""

from __future__ import annotations

import base64
import http.client
import json
import os
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from documents.errors import DocumentError
from documents.limits import MAX_BODY_BYTES
from documents.server import Operations, Service, make_handler

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
TEMPLATE = base64.b64encode(b"PK\x03\x04template-bytes").decode("ascii")


def fake_ops(render=None, convert=None) -> Operations:
    return Operations(
        render=render or (lambda data, values: b"filled-docx"),
        convert=convert or (lambda data, workdir: b"%PDF-1.7\nfake-pdf"),
    )


class ServerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.token = TOKEN
        self.ops = fake_ops()
        self.service = Service(self.token, self.ops)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.service))
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def call(self, method: str, path: str, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw.decode("utf-8", "replace")
        return response.status, parsed

    def fill(self, **overrides):
        payload = {"template": TEMPLATE, "values": {"customer": "Ada"}, "name": "invoice"}
        payload.update(overrides)
        return self.call("POST", "/fill", json.dumps(payload).encode(), AUTH)

    def test_healthz_needs_no_token(self) -> None:
        status, body = self.call("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True})

    def test_unknown_and_missing_token_are_401(self) -> None:
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic x"}):
            status, body = self.call("POST", "/fill", b"{}", headers)
            self.assertEqual(status, 401)
            self.assertEqual(body["error"]["code"], "unauthorized")

    def test_fill_returns_both_files(self) -> None:
        status, body = self.fill()
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(body["docx"]), b"filled-docx")
        self.assertTrue(base64.b64decode(body["pdf"]).startswith(b"%PDF-"))
        self.assertEqual(body["docxName"], "invoice.docx")
        self.assertEqual(body["pdfName"], "invoice.pdf")

    def test_values_are_checked(self) -> None:
        status, body = self.fill(values={"../bad": "x"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "bad_request")

    def test_body_cap(self) -> None:
        # The declared length is over the cap, so the server refuses before it
        # reads the (tiny) body. A raw socket avoids a client-side broken pipe.
        import socket

        request = (
            "POST /fill HTTP/1.1\r\nHost: localhost\r\n"
            f"Authorization: Bearer {TOKEN}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {MAX_BODY_BYTES + 1}\r\n"
            "Connection: close\r\n\r\n{}"
        ).encode()
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        try:
            sock.sendall(request)
            raw = b""
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                raw += chunk
        finally:
            sock.close()
        head, _, payload = raw.partition(b"\r\n\r\n")
        self.assertEqual(int(head.split(b" ")[1]), 413)
        self.assertEqual(json.loads(payload)["error"]["code"], "too_large")

    def test_macro_document_is_stable(self) -> None:
        self.ops.render = lambda data, values: (_ for _ in ()).throw(
            DocumentError("macro_document")
        )
        status, body = self.fill()
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "macro_document")
        self.assertNotIn("Traceback", str(body))

    def test_unknown_placeholder_is_stable(self) -> None:
        self.ops.render = lambda data, values: (_ for _ in ()).throw(
            DocumentError("unknown_placeholder")
        )
        status, body = self.fill()
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "unknown_placeholder")

    def test_timeout_is_stable(self) -> None:
        self.ops.convert = lambda data, workdir: (_ for _ in ()).throw(
            DocumentError("timeout")
        )
        status, body = self.fill()
        self.assertEqual(status, 504)
        self.assertEqual(body["error"]["code"], "timeout")

    def test_raw_libreoffice_stderr_is_never_returned(self) -> None:
        raw = (
            "Traceback (most recent call last):\n"
            "javaldx: Could not find a Java Runtime Environment!\n"
            "soffice.bin: /usr/lib/libreoffice/program/soffice: fatal error\n"
        )
        self.ops.convert = lambda data, workdir: (_ for _ in ()).throw(RuntimeError(raw))
        status, body = self.fill()
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "render_failed")
        text = json.dumps(body)
        for secret in ("Traceback", "javaldx", "soffice.bin", "fatal error"):
            self.assertNotIn(secret, text)

    def test_temp_dir_is_removed_on_success_and_failure(self) -> None:
        seen: list[str] = []
        self.ops.convert = lambda data, workdir: seen.append(workdir) or b"%PDF-1.7\nok"
        self.assertEqual(self.fill()[0], 200)
        self.assertTrue(seen)
        self.assertFalse(os.path.exists(seen[0]))

        self.ops.convert = lambda data, workdir: seen.append(workdir) or (_ for _ in ()).throw(
            DocumentError("convert_failed")
        )
        status, body = self.fill()
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "convert_failed")
        self.assertFalse(os.path.exists(seen[1]))

    def test_convert(self) -> None:
        payload = json.dumps({"document": TEMPLATE, "name": "paper"}).encode()
        status, body = self.call("POST", "/convert", payload, AUTH)
        self.assertEqual(status, 200)
        self.assertEqual(body["pdfName"], "paper.pdf")
        self.assertTrue(base64.b64decode(body["pdf"]).startswith(b"%PDF-"))

    def test_extract_endpoint_is_gone(self) -> None:
        payload = json.dumps({"name": "slides.pptx", "base64": TEMPLATE}).encode()
        status, body = self.call("POST", "/extract", payload, AUTH)
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")

    def test_unknown_endpoint_is_404(self) -> None:
        status, body = self.call("POST", "/shell", b"{}", AUTH)
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")

    def test_one_job_at_a_time(self) -> None:
        guard = threading.Lock()
        state = {"active": 0, "max": 0}

        def convert(data, workdir):
            with guard:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            time.sleep(0.08)
            with guard:
                state["active"] -= 1
            return b"%PDF-1.7\nserial"

        self.ops.convert = convert
        threads = [threading.Thread(target=self.fill) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertEqual(state["max"], 1)


if __name__ == "__main__":
    unittest.main()
