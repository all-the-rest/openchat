"""Shared protocol for the document scripts (issue #24).

Invocation: `python -I -B <script>.py <memory-mb>`, one JSON request on stdin,
exactly one JSON line on stdout. Anything a library raises is classified into a
stable code here; a traceback may still appear on stderr, but the TypeScript
runner never forwards stderr to the model.

The request carries no absolute paths: input and output are single names inside
the process's working directory, which is the throwaway temp dir the runner
created and removes.
"""

import json
import os
import resource
import sys

MAX_TEXT_CHARS = 200_000
DEFAULT_MEMORY_MB = 256


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code):
    """Report a stable code and exit zero: the protocol, not the exit, decides."""
    emit({"ok": False, "code": code})
    raise SystemExit(0)


def _limit_memory(mb):
    if mb <= 0:
        return
    limit = mb * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ValueError, OSError):
        # macOS and some kernels reject RLIMIT_AS; the data segment is the
        # closest bound they accept.
        try:
            resource.setrlimit(resource.RLIMIT_DATA, (limit, limit))
        except (ValueError, OSError):
            pass


def _read_request():
    try:
        data = json.load(sys.stdin)
    except Exception:
        fail("invalid_output")
    if not isinstance(data, dict):
        fail("invalid_output")
    return data


def local_name(request, key, default=None):
    """One file name inside the working directory; never a path."""
    name = request.get(key, default)
    if name is None:
        fail("invalid_output")
    if not isinstance(name, str) or not name:
        fail("invalid_output")
    if "/" in name or "\\" in name or name.startswith(".") or ".." in name:
        fail("invalid_output")
    return name


def local_path(request, key, default=None):
    return os.path.join(os.getcwd(), local_name(request, key, default))


def truncate(text):
    if len(text) <= MAX_TEXT_CHARS:
        return text
    return text[:MAX_TEXT_CHARS] + "\n\n[truncated]"


def run(handler):
    """Apply the memory cap, read the request, classify every failure."""
    mb = DEFAULT_MEMORY_MB
    if len(sys.argv) > 1:
        try:
            mb = int(sys.argv[1])
        except ValueError:
            mb = DEFAULT_MEMORY_MB
    _limit_memory(mb)
    request = _read_request()
    try:
        handler(request)
    except SystemExit:
        raise
    except MemoryError:
        fail("memory")
    except Exception:
        fail("crashed")
