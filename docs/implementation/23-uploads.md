# 23 — Upload and download transport

**Status:** 2026-11-18. Implements issue #21 (M4/M5). Storage, quotas and the
chat file list come from [#22](22-chat-files.md); this slice owns the wire
surface around them. No third-party request is made at any point.

## Flow

1. The owner picks a file with the paperclip, drops one on the composer, or
   pastes a file item from the clipboard.
2. The browser uploads the raw bytes **immediately**:
   `POST /api/sessions/:id/files?name=<name>` with `Content-Type:
   application/octet-stream`. The name is a query parameter, never a header;
   the raw body is never JSON. The failure therefore happens before a prompt
   is sent.
3. The BFF validates the name, caps the body at `WORKSPACE_MAX_FILE_BYTES`,
   sniffs the magic bytes and checks that the extension agrees. It stores the
   bytes through `ChatFilesStore.write` with the **sniffed** MIME and returns
   the resulting `ChatFileInfo` (`201`). The stored name is the server's — a
   collision becomes `report-1.pdf`, and the reference uses that name.
4. The composer shows a chip (name, size, remove). While any upload is in
   flight the send button is disabled. A rejection keeps the chip in an error
   state with an i18n explanation; the owner can remove it.
5. On send, a documented reference block is appended to the prompt `text`.
   There is no structured attachment field in the backend contract, and the
   bytes are never inlined.
6. The file list refetches after each successful upload and after a send. A
   produced file (origin `agent` or `upload`) is already a card there; the
   card's same-origin link downloads the exact bytes with
   `Content-Disposition: attachment`, `nosniff` and a sandbox CSP.

## Endpoints and guards

| Route | Result |
| --- | --- |
| `POST /api/sessions/:id/files?name=<name>` | Raw body, `201` + `ChatFileInfo`; `400` bad name, `413` size/quota, `415` sniff failure, `409` name conflict |
| `GET /api/sessions/:id/files/:name` | Exact bytes as an attachment (unchanged from #22) |
| `GET /api/sessions/:id/files` | `{ files, quota }` (unchanged from #22) |
| `DELETE /api/sessions/:id/files/:name` | `204` (unchanged from #22) |

The request guard already excludes this path from the JSON content-type
requirement and allows a larger declared body; the route and the store keep
the same `WORKSPACE_MAX_FILE_BYTES` and both quotas. An invalid name is
answered `400` **before** the body is sniffed, so a bad name never turns into a
type error.

## Content allowlist

Matching is on leading bytes, not on the client's MIME or the extension alone:

| Kind | Magic | Accepted extensions | Stored MIME |
| --- | --- | --- | --- |
| Plain text | no NUL in the first 8 KiB, not markup | `.txt`, `.md`, `.csv`, `.json`, `.log` | `text/plain; charset=utf-8` |
| PNG | `89 50 4E 47 0D 0A 1A 0A` | `.png` | `image/png` |
| JPEG | `FF D8 FF` | `.jpg`, `.jpeg` | `image/jpeg` |
| GIF | `GIF87a` / `GIF89a` | `.gif` | `image/gif` |
| WebP | `RIFF` at 0 and `WEBP` at 8 | `.webp` | `image/webp` |
| PDF | `%PDF-` | `.pdf` | `application/pdf` |
| DOCX | `PK\x03\x04` plus a `word/` entry | `.docx` | Word OpenXML MIME |
| XLSX | `PK\x03\x04` plus an `xl/` entry | `.xlsx` | Excel OpenXML MIME |
| PPTX | `PK\x03\x04` plus a `ppt/` entry | `.pptx` | PowerPoint OpenXML MIME |
| ZIP | `PK\x03\x04` without an Office marker | `.zip` | `application/zip` |

Everything else is `415 unsupported_media_type` with a stable code: empty
bodies, HTML/SVG (including markup renamed `.txt`), a NUL inside the text
sample, unknown binaries, a mismatched extension (a PDF renamed `.png`), and
extensions outside the table (`.html`, `.svg`, `.exe`). Office kind is read
from ZIP entry names, which the ZIP format stores uncompressed; a plain ZIP
that happens to contain a `word/` folder is classified as DOCX and rejected
unless its name is `.docx`. This is deliberately conservative: the type a file
claims must match what it is.

## Reference format

The formatter lives in one pure module,
`apps/web/src/chat/attachment-ref.ts`, and has no client paths in it:

```text
Attached files:
- report.pdf (/workspace/chats/<sessionID>/files/report.pdf)
```

`withAttachmentReferences(text, sessionID, storedNames)` appends the block
after a blank line; with no stored names it returns the text unchanged. The
path prefix is the documented container mount: the BFF's `WORKSPACE_DIR` is
mounted at `/workspace` in the agent container and the store appends
`chats/<sessionID>/files/`. The block is a **protocol constant**, not UI copy,
so it is identical in `en` and `de`. Chip labels and upload errors do go
through Lingui (`composer.attach*`, `composer.attachment*`); the German PO is
`src/locales/de/messages.po` and both compiled catalogues are regenerated with
`pnpm --filter @openchat/web i18n:compile`.

## Tests

- `apps/server/test/file-sniff.test.ts` — every accepted kind, the NUL
  boundary, markup/empty/binary rejection and extension agreement.
- `apps/server/test/chat-files-sniff.test.ts` — the route returns the sniffed
  MIME, rejects HTML-as-text, PDF-as-PNG, empty, NUL text and disallowed
  extensions with `415 unsupported_media_type`, keeps `400` for a bad name and
  `413` for an oversized body.
- `apps/web/test/attachment-ref.test.ts` — the exact block, the empty case and
  the stored-name-only rule.
- `apps/web/test/composer-attachments.test.tsx` — picker, drop, paste, ready
  chips, the appended prompt, the disabled-send guard, failed chips and i18n.
- `apps/web/e2e/uploads.spec.ts` — offline round trip: pick a PDF, send, assert
  the reference line in the transcript, download the card and compare bytes;
  plus drop, paste, a rejected type and the disabled-send state.

## Deliberately not done

- **Streaming uploads.** The whole body is buffered before sniffing; the cap
  is at most 25 MiB by default and the guard rejects a larger declared length
  before it reaches the socket.
- **`Range` / resumable downloads.** Downloads return the full bytes with an
  attachment disposition; the optional `Range` support from the issue is left
  for a future slice.
- **Thumbnails, previews and inline images.** Uploaded content is never
  previewed on the app origin; documents render only in the artifact sandbox.
- **Macro execution or archive inspection.** Office files are stored as bytes;
  the ZIP marker check is a type check, not a virus scan.
- **Client-side type/size checks.** The browser's `File.type` is never trusted
  or sent; the server is the single authority.
- **SSE-driven file-list refresh.** The page refetches after upload and send;
  an agent file written in the background appears on the next navigation or
  reload.
- **A structured attachment field in the prompt contract.** `PromptInput`
  still has only `text`; the reference block is the documented transport.
