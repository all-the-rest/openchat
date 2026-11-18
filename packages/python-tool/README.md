# @openchat/python-tool

The MCP server for generated documents. Four typed tools over one pinned Python
environment — no `python -c` from the model:

| Tool | In | Out |
| --- | --- | --- |
| `docx_fill` | title + paragraphs, or a base64 `.docx` template + `values` | one `.docx` artifact |
| `xlsx_write` | typed rows per sheet | one `.xlsx` artifact |
| `pdf_from_markdown` | Markdown | one selectable-text PDF artifact |
| `read_document` | base64 `.docx` / `.xlsx` / `.pdf` | Markdown text |

Each tool validates its arguments in TypeScript, runs one fixed script from
`python/` as a subprocess (JSON on stdin, 30 s deadline, 256 MiB address-space
cap, throwaway temp dir as cwd) and classifies every failure into a stable
message. A Python traceback never reaches the model.

Generated files are stored through the existing artifact write path
(`POST /internal/artifacts`, bearer `ARTIFACT_INTERNAL_TOKEN`) as one
self-contained HTML artifact that carries the file as a base64 `data:` URL. The
artifact id remains the SHA-256 of that one document; there is no second store.
See [`docs/implementation/14-deployment.md`](../../docs/implementation/14-deployment.md#python-document-tools)
for the size budget, the version deviation and the sandbox.

## Run

```bash
pnpm run setup:python                             # creates .venv from Python >= 3.12
OPENCHAT_PYTHON="$PWD/.venv/bin/python" \
  pnpm --filter @openchat/python-tool run start   # stdio MCP server
```

| Variable | Meaning |
| --- | --- |
| `OPENCHAT_BFF_URL` | BFF base URL; defaults to `http://127.0.0.1:8787`. |
| `ARTIFACT_INTERNAL_TOKEN` | Bearer token for `POST /internal/artifacts`; required. |
| `OPENCHAT_PYTHON` | Interpreter command or absolute path; defaults to `python3`. |

## Test

```bash
pnpm --filter @openchat/python-tool run test
```

The unit suite uses a fake subprocess runner and needs no interpreter. The one
integration test runs the real scripts and skips when `python3` (or
`OPENCHAT_PYTHON` / `.venv/bin/python`) lacks the pinned imports.
