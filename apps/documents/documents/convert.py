"""DOCX -> PDF through LibreOffice headless, one job at a time.

The LibreOffice profile and HOME live in the per-request temp directory, so two
conversions never share a lock file and nothing is written to the image. stderr
is captured only to drain the pipe and is deliberately discarded: the caller
never sees a raw LibreOffice message, only a stable error code.
"""

from __future__ import annotations

import os
import signal
import subprocess
from typing import Callable

from .errors import DocumentError
from .limits import CONVERT_TIMEOUT_SECONDS, MAX_OUTPUT_BYTES

Converter = Callable[[bytes, str], bytes]
PDF_PREFIX = b"%PDF-"


def _checked(result: bytes) -> bytes:
    if not isinstance(result, (bytes, bytearray)) or not result.startswith(PDF_PREFIX):
        raise DocumentError("convert_failed")
    if len(result) > MAX_OUTPUT_BYTES:
        raise DocumentError("too_large")
    return bytes(result)


def docx_to_pdf(
    data: bytes,
    workdir: str,
    converter: Converter | None = None,
    timeout: int = CONVERT_TIMEOUT_SECONDS,
) -> bytes:
    """Convert DOCX bytes to PDF bytes. The shell is never involved."""
    if converter is not None:
        try:
            result = converter(data, workdir)
        except DocumentError:
            raise
        except Exception:
            raise DocumentError("convert_failed")
        return _checked(result)

    source = os.path.join(workdir, "input.docx")
    with open(source, "wb") as handle:
        handle.write(data)

    environment = os.environ.copy()
    environment["HOME"] = workdir
    environment["TMPDIR"] = workdir
    environment["LANG"] = "C.UTF-8"
    profile = "file://" + os.path.join(workdir, "lo-profile")
    command = [
        "soffice",
        "--headless",
        "--norestore",
        "--nodefault",
        "--nolockcheck",
        "-env:UserInstallation=" + profile,
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        workdir,
        source,
    ]

    process: subprocess.Popen | None = None
    try:
        process = subprocess.Popen(
            command,
            cwd=workdir,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        # stderr is drained into the pipe and intentionally never read into a
        # message. A conversion failure is one fixed sentence, not a traceback.
        process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            process.communicate()
        raise DocumentError("timeout")
    except (OSError, subprocess.SubprocessError):
        raise DocumentError("convert_failed")

    if process is None or process.returncode != 0:
        raise DocumentError("convert_failed")

    target = os.path.join(workdir, "input.pdf")
    try:
        with open(target, "rb") as handle:
            result = handle.read()
    except OSError:
        raise DocumentError("convert_failed")
    return _checked(result)
