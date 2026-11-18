"""Hard limits. All are checked before LibreOffice starts."""

from __future__ import annotations

# One JSON request: an 8 MiB template becomes ~11 MiB of base64 plus values.
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_TEMPLATE_BYTES = 8 * 1024 * 1024
MAX_VALUES = 100
MAX_VALUE_CHARS = 2_000
MAX_KEY_CHARS = 64
MAX_NAME_CHARS = 200
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_MARKDOWN_CHARS = 200_000
# LibreOffice is single-profile and slow to start; one job at a time.
CONVERT_TIMEOUT_SECONDS = 30
TOTAL_TIMEOUT_SECONDS = 45
# A request thread that outlives this is abandoned, not left holding the lock.
REQUEST_TIMEOUT_SECONDS = 60
MAX_ZIP_ENTRIES = 5_000
