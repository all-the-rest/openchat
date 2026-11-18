# 25 — Documents: templates, generated DOCX, PDF fonts

**Status:** 2026-11-18. Implements issue #46 and the document half of issue #22
on top of the new `main` (`b01d695`, markitdown preinstalled in the agent
image). Architecture:
[`../architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md);
deployment: [`14-deployment.md`](14-deployment.md); working files:
[`22-chat-files.md`](22-chat-files.md).

## What this slice adds

The agent image can already create DOCX/XLSX/PDF (`docx_fill`, `xlsx_write`,
`pdf_from_markdown`) and read DOCX/XLSX/PPTX/PDF/HTML locally (`read_document`,
markitdown). Two gaps remained: there was no DOCX built from data (only a
template fill), and `pdf_from_markdown` set text in non-embedded Base-14 fonts.
Both are closed here, together with a byte-stable DOCX and an embedded DejaVu
family.

| Piece | Path | Job |
| --- | --- | --- |
| Documents image | `deploy/Dockerfile.documents` | Debian glibc + LibreOffice writer-nogui + four pinned Python libraries |
| Service | `apps/documents/documents/` | stdlib HTTP server: `/fill`, `/convert`, `/healthz` |
| Lock | `apps/documents/requirements.lock` | fully pinned, offline runtime |
| Tools | `packages/python-tool/src/{template,chat-output,documents-client}.ts`, `tool.ts` | `documents_fill`, `documents_convert` |
| Generated DOCX | `packages/python-tool/src/{markdown,validate-from-text}.ts`, `python/docx_from_text.py` | `docx_from_text`: blocks or Markdown → DOCX, byte-stable |
| PDF fonts | `deploy/Dockerfile.opencode`, `python/pdf_from_markdown.py` | `font-dejavu`, embedded subset, Helvetica fallback |
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
service with `DOCUMENTS_URL` / `DOCUMENTS_TOKEN`. `docx_fill`, `xlsx_write`,
`pdf_from_markdown` and `read_document` are unchanged.

## Generated DOCX without a template (issue #22)

`docx_from_text` builds a new document from structured data or from Markdown;
no template is read and no LibreOffice is involved. It is one tool with one
block model rather than two tools, so the caps, the renderer and the tests
exist once.

| Input | Meaning |
| --- | --- |
| `blocks` | 1–500 typed blocks: `heading` (level 1–3), `paragraph`, `bullet`, `code`, `table` |
| `markdown` | the subset below, converted to the same blocks by `src/markdown.ts` |
| `chatPath` | `<sessionID>/files/<name>.docx`, relative to `WORKSPACE_DIR/chats` |
| `title` | optional; the artifact title and, when given, the document's Title paragraph |

Exactly one of `blocks` and `markdown` is required. Markdown support is a
deliberately small subset: h1–h3, paragraphs (a soft line break becomes a
space), `-`/`*` bullets, fenced code (verbatim, language tag dropped) and pipe
tables with a `|---|` delimiter row, where the first row is the header. Anything
else — HTML, images, links, ordered lists, quotes, nested lists, emphasis —
stays literal text. The caps are 500 blocks, 20 000 characters of total text,
50 table rows and 8 columns; the validator rejects an oversized call before a
process starts and the script re-checks the same numbers. A violated cap on the
script side is `too_many`, an oversized document is `too_large`.

The page is A4 with 2 cm margins. The style set is the library's Title,
Heading 1–3, Normal, List Bullet and Table Grid plus one generated `Code`
paragraph style (Courier New 9 pt), so a document never depends on a style a
reader's Word installation lacks.

**Deterministic output.** The same request produces the same bytes: the core
properties (`created`, `modified`, author, last-modified-by, revision) are
pinned, python-docx's default description is cleared, and every zip entry is
rewritten with a fixed 1980-01-01 timestamp and mode 0600. Two runs are
compared byte for byte in the unit test and in the network-less image smoke
test, so a re-run of an identical request is detectable as a change.

Output caps: the script refuses a DOCX over 10 MiB (`too_large`) before the
bytes are base64-encoded, and the artifact wrapper — like every document tool —
stops at 700 KiB, because the card embeds the file in one artifact document.
The chat file itself is written first and the card second, so a rejected card
never leaves a download pointing at bytes that were never written.

## PDF fonts: DejaVu, embedded

reportlab's Base-14 fonts (`Helvetica`, `Courier`) are not embedded and cover
neither Greek nor Cyrillic, so "no missing glyphs" was not met.
`pdf_from_markdown.py` now sets body text and headings in DejaVu Sans and code
in DejaVu Sans Mono, and reportlab embeds a subset with a `ToUnicode` map, so
the text is extractable, not just visible:

| Piece | Detail |
| --- | --- |
| Package | `font-dejavu=2.37-r6` in the Python layer of `deploy/Dockerfile.opencode`; 9,990 KiB installed |
| Location | `/usr/share/fonts/dejavu/DejaVuSans{,-Bold,-Oblique,-BoldOblique}.ttf` and the four mono faces |
| Override | `OPENCHAT_FONT_DIR` for a development tree without apk |
| Fallback | one missing face → the whole family falls back to Helvetica/Courier, never a half family |
| Licence | DejaVu fonts: Bitstream Vera derivative, free to use, embed and redistribute; nothing is downloaded at runtime |

The package name was verified against the image's own repositories
(`apk info -L font-dejavu`), the version is pinned, and the build asserts both
TTF paths right after `apk add`, so a repository bump fails the build instead of
silently changing glyph coverage. The smoke test renders
`Grüße — Ω — Привет` with `--network=none` and fails unless all three samples
come back from the PDF text layer and the resource name says `DejaVuSans`; the
unit tests do the same extraction with pypdf (a test-only pin in
`requirements-test.lock`) and also prove the Helvetica fallback when the
directory is empty or incomplete.

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

The generated-DOCX tool makes its own omissions explicit, so a reader does not
expect a word processor:

- **No HTML.** A Markdown input is parsed as the subset above; tags stay text.
  The tool never executes or renders markup, and the BFF never serves a DOCX as
  HTML.
- **No remote images.** There is no image block and no fetch path; `![alt](url)`
  remains literal text, and the renderer has no network access.
- **No template gallery, no template library.** `docx_from_text` starts from an
  empty document; `documents_fill` fills an uploaded `.docx`/`.dotx` and nothing
  else. Both write into the chat that asked, not into a shared store.
- **No `w:sdt`, no fields, no charts, footnotes, columns or pagination
  control.** The block model is intentionally flat; anything beyond it belongs
  to the template path.
- **The export affordance is still agent-driven.** The tools are MCP tools on
  the agent side, not BFF endpoints, so a one-click "export this answer" needs a
  Markdown→DOCX/PDF route on the documents service; that remains open on #22.
  Until then the model calls the tool and the chat shows the resulting cards.

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
- `packages/python-tool/test/{markdown,validate-from-text,tool-from-text,chat-output}.test.ts`
  — the Markdown subset and its literal-text omissions, every block cap with
  its message, derived titles, `chatPath` guards, validation before a process,
  collision suffix and card name, oversized output, no write when the card is
  rejected.
- `packages/python-tool/python/tests/test_docx_from_text.py` — one case per
  block kind, A4/2 cm page setup, style set, fixed core properties, two runs
  byte-identical, the 500-block/20 000-character/50×8 caps, the 10 MiB output
  cap, and the stdin→stdout contract without a traceback.
- `packages/python-tool/python/tests/test_pdf_fonts.py` — DejaVu registration
  and subset embedding (BaseFont prefix, `ToUnicode`), pypdf extraction of
  `Grüße — Ω — Привет`, the Helvetica fallback for a missing or incomplete
  family, `OPENCHAT_FONT_DIR`, deterministic PDF bytes.
- `deploy/python-smoke.py` — run under `--network=none` in the image: the four
  markitdown fixtures, `read_document`, the corrupt-DOCX code, a DOCX built
  twice with identical bytes, and the DejaVu PDF text layer.
- `apps/server/test/{deployment,remote-compose-merge,remote-deploy-limits,remote-deploy-build,remote-deploy}.test.ts`
  — service set, no port, backend only, token interpolation, image pins, build
  set, mem/reservation, seed-config fields.
