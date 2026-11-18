/**
 * One set of numbers for the validator, the HTML wrapper and the Python
 * scripts. The store caps an artifact at 1 MiB; base64 inflates a file by 4/3,
 * so the raw file stays well below that. The Python side enforces the same
 * ceiling even when a script is called without the Node runner.
 */

/** Largest raw file the wrapper will embed in one artifact (700 KiB). */
export const MAX_FILE_BYTES = 700 * 1024

/** Largest `markdown` input of `pdf_from_markdown`, as UTF-8 bytes. */
export const MAX_MARKDOWN_BYTES = 200_000

/** Largest MCP text preview for `read_document`, in UTF-8 bytes. */
export const READ_PREVIEW_BYTES = 8 * 1024

/** Subprocess wall clock; a runaway converter is killed, never waited on. */
export const TOOL_TIMEOUT_MS = 30_000

/** The runner refuses to buffer more than this from a child process. */
export const CHILD_OUTPUT_MAX_BYTES = 2 * 1024 * 1024

/** Request/response envelope cap for one script, in bytes. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024

export const MAX_TITLE = 120
export const MAX_OUTPUT_NAME = 120
export const MAX_VALUES = 64
export const MAX_VALUE_CHARS = 2_000
export const MAX_PARAGRAPHS = 200
export const MAX_ROWS = 5_000
export const MAX_HEADERS = 50
export const MAX_FORMULAS = 200
export const MAX_CELL_CHARS = 2_000

/** The artifact store's own limits, repeated here so a wrapper is rejected early. */
export const ARTIFACT_MAX_BYTES = 1_048_576
export const ARTIFACT_TITLE_MAX = 120
