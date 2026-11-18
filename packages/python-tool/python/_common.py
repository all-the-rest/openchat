"""Shared plumbing for the document scripts.

Every script reads one JSON object on stdin and writes one JSON object on
stdout. Nothing is read from the filesystem except the process working
directory (the temporary directory the Node runner creates), nothing is
written there permanently, and no exception text or traceback ever reaches
stdout: the Node side maps a stable code to a fixed message.
"""

import base64
import json
import resource
import sys
from typing import NoReturn

# The artifact store caps one document at 1 MiB. Base64 inflates by 4/3, so the
# raw file must stay below this bound; the Node runner checks the same number.
MAX_FILE_BYTES = 700 * 1024
MAX_REQUEST_BYTES = 4 * 1024 * 1024
MEMORY_LIMIT = 512 * 1024 * 1024


def fail(code: str) -> NoReturn:
    """Emit one fixed error code and leave without a traceback."""
    sys.stdout.write(json.dumps({"ok": False, "code": code}, separators=(",", ":")))
    sys.stdout.flush()
    raise SystemExit(1)


def read_request() -> dict:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        fail("too_large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        fail("invalid_input")
    if not isinstance(payload, dict):
        fail("invalid_input")
    return payload


def decode_payload(value) -> bytes:
    if not isinstance(value, str):
        fail("invalid_input")
    try:
        return base64.b64decode(value, validate=True)
    except Exception:
        fail("invalid_input")


def emit(filename: str, media_type: str, data: bytes) -> None:
    if len(data) > MAX_FILE_BYTES:
        fail("too_large")
    encoded = base64.b64encode(data).decode("ascii")
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "filename": filename,
                "mediaType": media_type,
                "data": encoded,
            },
            separators=(",", ":"),
        )
    )
    sys.stdout.flush()


def cap_memory() -> None:
    """A hard virtual-memory ceiling for the whole interpreter."""
    try:
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    except (OSError, ValueError):
        # musl or a restricted container may refuse; the timeout still applies.
        pass


def run(main) -> None:
    cap_memory()
    try:
        main(read_request())
    except SystemExit:
        raise
    except MemoryError:
        fail("too_large")
    except Exception:
        fail("render_failed")
