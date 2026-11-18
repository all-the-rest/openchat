# 25 — Documents service: Word templates, DOCX → PDF

**Status:** 2026-11-18. Implements issue #46 on top of the new `main`
(`b01d695`, markitdown preinstalled in the agent image). Architecture:
[`../architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md);
deployment: [`14-deployment.md`](14-deployment.md); working files:
[`22-chat-files.md`](22-chat-files.md).

## What this slice adds

The agent image can already create DOCX/XLSX/PDF (`docx_fill`, `xlsx_write`,
`pdf_from_markdown`) and read DOCX/XLSX/PPTX/PDF/HTML locally (`read_document`,
markitdown). It cannot render an uploaded Word template to PDF: reportlab builds
new PDFs and does not convert OOXML. That is the one gap this slice closes.

| Piece | Path | Job |
| --- | --- | --- |
| Documents image | `deploy/Dockerfile.documents` | Debian glibc + LibreOffice writer-nogui + four pinned Python libraries |
| Service | `apps/documents/documents/` | stdlib HTTP server: `/fill`, `/convert`, `/healthz` |
| Lock | `apps/documents/requirements.lock` | fully pinned, offline runtime |
| Tools | `packages/python-tool/src/{template,chat-output,documents-client}.ts`, `tool.ts` | `documents_fill`, `documents_convert` |
| Compose | `compose.yaml`, `deploy/remote/compose.yaml` | internal service, token from `.env`, no port |
| Deploy | `deploy/remote/{deploy,env-bootstrap,seed-config}.sh` | six-image build, token bootstrap, MCP wiring |

## Why a second runtime

LibreOffice must be glibc and is large. Measured on this host (arm64,
`python:3.13-slim` digest `sha256:e48f59cd…`, 2026-11-18):

| Layer | Size |
| --- | --- |
| `libreoffice-writer-nogui`, `libreoffice-core-nogui`, Carlito/Caladea, DejaVu, fontconfig | 384 MB |
| `docxtpl`, `python-docx`, `pypdf`, `pillow` + transitive | 46 MB |
| digest-pinned Python 3.13 base | ~50 MB |
| **final image** | **789,989,813 B (790 MB)** |

Installing markitdown here was tried and rejected: its `magika` →
`onnxruntime` → `numpy`/`pandas` stack added another 379 MB (the same build was
1,168,845,341 B with markitdown). Since `b01d695` the Alpine agent image ships
markitdown locally, so `read_document` stays untouched and there is **no**
`/extract` endpoint and no markitdown dependency in this image. One format,
one path — the extra 379 MB bought a duplicate implementation.

The image carries no Node, no repo checkout, no fonts downloaded at runtime
and no token. Build uses the index; the running container makes no outbound
request.

## The `.dotx` rewrite

`python-docx` and `docxtpl` reject a real `.dotx`: its main part is declared as
`…wordprocessingml.template.main+xml`. The service inspects
`[Content_Types].xml` and classifies the package as `docx`, `dotx` or `macro`
(by content type **and** by a `vbaProject.bin` part — never by extension). For
a `dotx` it rewrites that one content-type string in a throwaway zip copy and
hands the copy to `docxtpl`; the uploaded bytes are never changed. The
real-fixture test fills `{{ customer }}` and a `{% for item in items %}` table,
then renders, and checks the text in both the DOCX XML and the PDF text layer.

## Endpoints

All responses are JSON; errors are always
`{"error":{"code":"…","message":"one fixed sentence"}}`. `GET /healthz` needs
no token. Every other route needs `Authorization: Bearer <DOCUMENTS_TOKEN>`;
a wrong or missing token is `401 unauthorized`.

| Route | Request | Response |
| --- | --- | --- |
| `POST /fill` | `template` (base64 DOCX/DOTX), `values` (JSON scalars/lists/maps), `name` | `docx`, `pdf` (base64), `docxName`, `pdfName` |
| `POST /convert` | `document` (base64 DOCX), `name` | `pdf` (base64), `pdfName` |

Stable codes: `invalid_template`, `unknown_placeholder`, `render_failed`,
`convert_failed`, `macro_document`, `too_large`, `timeout`, `bad_request`,
`unauthorized`, `not_found`. A Jinja `UndefinedError` maps to
`unknown_placeholder`; a LibreOffice failure maps to `convert_failed`. stderr
is drained into a pipe and discarded — only the exception *type* is logged
server-side, never a traceback, a raw library message or a path.

## Limits and sandbox

- Body cap 16 MiB (an 8 MiB template is ~11 MiB of base64); template cap
  8 MiB; 100 value keys; 200 array entries; nesting depth 4; names 1–200
  characters without separators.
- One job at a time: a process-wide lock covers render + convert because a
  LibreOffice profile is single-user. Three concurrent requests serialise.
- Per-request `TemporaryDirectory`; `HOME`, `TMPDIR` and
  `-env:UserInstallation=file://<temp>/lo-profile` point into it, and it is
  removed on success and on every error path.
- `soffice --headless --norestore --nodefault --nolockcheck --convert-to
  pdf:writer_pdf_Export`, argv array, no shell, 30 s deadline; on timeout the
  process group is SIGKILLed. No macros: `.docm`/`.dotm` are rejected by
  content type and part name before LibreOffice starts.
- `read_only: true`, `/tmp` tmpfs (256 MiB), `no-new-privileges:true`,
  1024 MiB memory / 384 MiB reservation on the remote host, no published port,
  `backend` network only. There is no network-egress code path; the service
  never fetches a URL, a font or a package.

## Tools

`documents_fill` takes `templatePath` (`<sessionID>/files/<name>.docx|.dotx`,
relative to `WORKSPACE_DIR/chats`), `values` and an optional `name`. The path is
parsed into exactly three segments; every directory is `lstat`-ed and
`realpath`-ed (no symlinks, parent must be the real `chats` root), the template
is opened with `O_RDONLY | O_NOFOLLOW`, must be a singly-linked regular file
≤ 8 MiB, and its resolved path must still sit directly in that chat's `files/`.
No arbitrary absolute path is accepted. The filled DOCX and its PDF are
written back into that same folder with `O_CREAT | O_EXCL | O_NOFOLLOW` (0600,
collision suffixes `-1`, `-2`, …), and each is stored as a downloadable
artifact card. The text result names both files.

`documents_convert` takes a `.docx` path with the same guards, converts it and
writes/stores only the PDF. Neither tool starts Python locally; both call the
service with `DOCUMENTS_URL` / `DOCUMENTS_TOKEN`. The four existing tools and
`read_document` are unchanged.

## Fidelity and deliberate omissions

LibreOffice is not Word. Fonts, exotic fields and complex tables can render
differently; Carlito/Caladea are metric-compatible with Calibri/Cambria, which
removes the common font shift but not every edge case. Pixel fidelity is **not**
promised. Images in templates are not filled in v1. There is no template
gallery, no global library and no content-control (`w:sdt`) authoring — Jinja
tags are the authoring model. Generated files are written into the chat folder
with the same 0600/no-follow rules as uploads; the BFF's `index.json` is not
updated by the tool, so the artifact cards (not the folder listing) are the
authoritative download surface until a bearer-authenticated internal chat-file
write route exists. markitdown extraction stays in the agent image; the
service has no `/extract`.

## Tests

- `apps/documents/tests/test_ooxml.py` — classification, dotx rewrite, real
  `.docm` fixture rejected, bad packages.
- `apps/documents/tests/test_server.py` — fake renderer/converter: 401, body
  cap, both outputs, temp-dir cleanup, single job, stable codes for macro,
  unknown placeholder, timeout and raw-LibreOffice-stderr, `/extract` gone.
- `apps/documents/tests/integration.py` — opt-in, skips without LibreOffice:
  real `.dotx` fixture → selectable PDF with pypdf text assertions; missing
  placeholder; macro fixture.
- `packages/python-tool/test/{template,chat-output,documents-client,tool-documents,validate-documents,env-documents}.test.ts`
  — path guards, symlink refusal, size cap, collision-safe output writes,
  service-client error mapping with no traceback, tool-level wiring.
- `apps/server/test/{deployment,remote-compose-merge,remote-deploy-limits,remote-deploy-build,remote-deploy}.test.ts`
  — service set, no port, backend only, token interpolation, image pins, build
  set, mem/reservation, seed-config fields.
