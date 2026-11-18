"""archive_extract: extract a plain .zip into one chat files folder.

The destination and the quota numbers come from the Node boundary, which has
already resolved them inside `WORKSPACE_DIR/chats`. Every entry is checked
again here: the script must stay safe when called without the MCP server.
"""

from _archive import emit_json, extract_archive, run_archive
from _common import fail


def main(payload: dict) -> None:
    path = payload.get("path")
    if not isinstance(path, str) or not path.startswith("/"):
        fail("invalid_input")
    emit_json(extract_archive(payload))


run_archive(main)
