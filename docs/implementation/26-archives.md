# 26 — ZIP archives: inspect and extract with guards

**Status:** 2026-11-18. Implements issue #52 (M3e) on top of #46. Uploads,
quotas and the chat file layout: [`22-chat-files.md`](22-chat-files.md) and
[`23-uploads.md`](23-uploads.md). Document tools:
[`25-documents.md`](25-documents.md).

## What this slice adds

An upload may already be a `.zip` (magic `PK\x03\x04`, extension must agree,
stored as `application/zip`), but nothing could look inside it. The agent image
has no `unzip` and adds no dependency, so the tools use Python's stdlib
`zipfile` inside the existing fixed-script runner: one JSON request on stdin,
one JSON answer on stdout, a fresh temporary working directory, a 30 s
deadline, a 1 GiB address-space cap, and a stable error code instead of a
traceback.

| Piece | Path | Job |
| --- | --- | --- |
| Shared reader | `packages/python-tool/python/_archive.py` | name/type/bomb checks, listing, guarded extraction |
| Scripts | `packages/python-tool/python/{archive_list,archive_extract}.py` | one fixed entry point each |
| Validation | `packages/python-tool/src/validate-archives.ts` | turn arguments into one validated call |
| Tool layer | `packages/python-tool/src/archive.ts` | resolve the chat file, sum usage, call the runner |
| Boundary | `packages/python-tool/src/runner-archive.ts`, `runner.ts` | process rules, payload shape check |
| MCP | `packages/python-tool/src/mcp.ts` | two typed tool definitions |
| UI | `apps/web/src/chat/ChatFiles.tsx`, `i18n/messages/files.ts` | generic "Archive" badge, size, download; no preview |

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| `archive_list` | `zipPath` = `<sessionID>/files/<name>.zip` | entries `{name, size, compressedSize, directory}` plus totals (entries, files, directories, uncompressed/compressed bytes) |
| `archive_extract` | `zipPath`, `directory` (1–64 chars `[A-Za-z0-9._-]`) | files written below `files/<directory>/`, each `{path, size}`, plus the total bytes |

`zipPath` is parsed into exactly three segments, exactly as the document tools
parse `templatePath`. An absolute path, a backslash, `..`, a control character,
a leading dot or a non-`.zip` name is rejected before any filesystem access.
The subdirectory is a new folder under the chat's real `files/` directory; it
is never `.` or `..` and never a path.

Plain `.zip` only. DOCX, XLSX and PPTX are ZIP containers but keep their
dedicated reader: `read_document` understands their XML. `.tar.gz` is out of
scope: `tarfile` adds link/device and absolute-name rules of its own and the
upload allowlist carries no tar type, so a second format would only widen the
attack surface.

## Caps

Every number is enforced twice: once in the Node validator/tool layer and once
in `_archive.py`, so a direct script call is no weaker than the MCP path.

| Cap | Value | Enforced on |
| --- | --- | --- |
| Archive size | 20 MiB (`CHAT_FILE_MAX_BYTES`) | source `lstat` |
| Entries | 500 | listing and extraction |
| Depth | 10 path segments | listing and extraction |
| Total uncompressed | 200 MiB | declared sizes before extraction, actual bytes while writing |
| Per extracted file | 20 MiB | declared size and actual bytes |
| Chat quota | 100 MiB (`CHAT_QUOTA_PER_CHAT_BYTES`) | existing on-disk usage + bytes written |
| Compression ratio | 100:1 above 10 MiB uncompressed | declared sizes for listing, actual bytes for extraction |
| One name | 1000 chars, 200 per segment | listing and extraction |

The chat quota is summed from the real `files/` tree (without following
symlinks), not from the BFF's `index.json`: nested extracted files have no
index row, and counting them is the conservative choice. The shipped compose
file never overrides `WORKSPACE_MAX_FILE_BYTES` or the two quota variables, so
the BFF and the tool use the same defaults; a hand-edited deployment that
changes them accepts that the archive tool keeps the documented defaults.

## Threat model

The archive is untrusted input produced by the owner's upload or by the agent.
The owner is the only user, but the agent may fetch an archive, so the tool must
not turn "read this ZIP" into "write outside the chat".

| Threat | Guard |
| --- | --- |
| Path traversal (`../x`, `a/../../x`) | every segment is checked for `..`, `.` and empty; no path is joined before that check |
| Absolute target (`/etc/passwd`) | a leading `/` is refused; the only base is the resolved chat `files/` directory |
| Windows drive prefix (`C:/…`) | refused; backslashes are refused too, so one name cannot mean two paths |
| NUL and control characters | refused in the source path, the subdirectory and every entry name |
| Symlink, hardlink, device, FIFO, socket entry | the high 16 bits of `external_attr` are read as the Unix mode; anything that is explicitly neither regular nor directory is refused. A ZIP has no hard-link record, so a second name for one target is caught as a duplicate name instead |
| Duplicate entry names | refused (the only alias a ZIP can carry) |
| Nested bomb | declared total above 10 MiB with a ratio above 100:1 is refused before writing; the actual byte counter applies the same rule while decompressing, so a lying header cannot pass |
| Entry bomb / disk fill | declared and actual per-file and total caps, plus the chat quota checked before **each** entry |
| Encrypted archive | general-purpose flag bit 0 is refused: no password API and no prompt path |
| Overwrite | `O_CREAT \| O_EXCL \| O_NOFOLLOW`, mode 0600; collisions are pre-flighted and refused with `already_exists`; a mid-write collision rolls back everything this call created |
| Escape through the destination | Node resolves the real `chats/<session>/files`, `lstat`s it, and Python re-checks that the base is an absolute existing directory; each created directory is `lstat`ed, and an existing symlink or non-directory is refused |
| Resource exhaustion | 500 entries, 10 segments, 200 MiB, 30 s wall clock, 1 GiB address space, 2 MiB child stdout |

The address-space figure is the shared `_common.py` cap, so it covers every
Python tool and not only the archive reader. It must cover the address space
markitdown reserves through magika and onnxruntime — 512 MiB failed the DOCX
smoke on Linux/musl, where `RLIMIT_AS` is enforced — so 1 GiB is the floor. The
container's own memory limit remains the real bound.

## Collision rule

Choosing a suffixed name would silently change what the caller asked for and
split one extraction over several folders. The tool therefore refuses the whole
call with `already_exists` and writes nothing: the target subdirectory may hold
no file with any of the archive's names. Re-running the same extraction is a
no-op error, not a merge. To extract again, choose another `directory` or
delete the previous folder.

Extraction records every file and directory it creates and removes them in
reverse on any refusal, so a rejected archive leaves no partial tree, no
temporary file and no half-written entry.

## Stable error codes

The script prints `{"ok":false,"code":"…"}`; the Node boundary maps only that
code to one fixed sentence. stderr and tracebacks are never parsed or returned.

| Code | Message |
| --- | --- |
| `bad_archive` | `archive: the file is not a readable ZIP archive` |
| `encrypted` | `archive: the ZIP has encrypted entries` |
| `unsafe_entry` | `archive: the ZIP contains an unsafe entry` |
| `too_many_entries` | `archive: the ZIP has more than 500 entries` |
| `too_deep` | `archive: a path nests deeper than 10 directories` |
| `archive_too_large` | `archive: the ZIP expands beyond the 200 MiB uncompressed cap` |
| `bomb` | `archive: refused as a likely zip bomb` |
| `file_too_large` | `size: an extracted file exceeds the 20 MiB chat file cap` |
| `quota_exceeded` | `quota: the chat file quota would be exceeded` |
| `already_exists` | `already_exists: the target exists; choose another directory` |
| `invalid_input` | `input: the request could not be read` |
| `internal` | `internal: the archive tool failed` |

## UI

A stored ZIP is one row in the existing chat file list: name, an
`files.kind.archive` badge ("Archive" / "Archiv"), size, origin and the
same-origin download link. There is no inline preview, no frame and no image
element — the app origin never renders archive content. The badge is driven by
the stored MIME (`application/zip`), not by the file name. Labels are in
`apps/web/src/i18n/messages/files.ts`; the German text lives in the PO
catalogue and both compiled bundles are regenerated with
`pnpm --filter @openchat/web i18n:compile`.

## Tests

- `packages/python-tool/test/archive-python.test.ts` — real stdlib `zipfile`
  fixtures: nested directories, unicode names, traversal, absolute, drive
  prefix, symlink, duplicate, depth, 501 entries, encrypted, ratio bomb,
  26 MiB entry; extraction writes bytes and mode 0600, refuses collisions
  without partial output, enforces quota, per-file cap and bomb guard, and
  rolls back on every refusal, then drives `archive_list` and
  `archive_extract` through `runDocumentTool` with the real runner. It skips
  only when `python3` is absent.
- `packages/python-tool/test/archive.test.ts` — path shape, regular/singly
  linked/real-path checks, symlink and hardlink refusal, empty and oversized
  archives, usage summing, exact runner inputs and caps, tool dispatch.
- `packages/python-tool/test/{validate-archives,runner-archive,format}.test.ts`
  — argument rules, payload shape check, fixed error mapping, bounded text.
- `packages/python-tool/test/mcp.test.ts` — both tools are listed.
- `apps/web/test/chat-files.test.tsx` — ZIP row shows the archive badge, size
  and download, and neither an image nor an iframe.
- `apps/web/e2e/uploads.spec.ts` — upload a ZIP, see the archive card, download
  it byte-exact.
- `deploy/python-smoke.py` — build-time, `--network=none`: the list and extract
  scripts work on a stdlib fixture in the image.

Mutation evidence for the security tests (each change was applied alone, the
suite failed, then the change was reverted):

| Guard removed | Failing tests |
| --- | --- |
| the `..`/absolute/drive/backslash check in `_segments` | the traversal fixture is listed instead of `unsafe_entry`, and extraction writes outside the destination |
| the `BOMB_RATIO`/`BOMB_FLOOR` check in `_read_entries` | the 12 MiB-of-zeros fixture is accepted instead of `bomb` |

## Deliberate omissions

- **No extracted-file card and no download route for nested paths.** The BFF's
  chat file list and `GET …/files/:name` accept one path segment, so
  `files/<directory>/…` is readable by the agent (and by `read_document` for a
  document) but is not listed or downloaded through the UI. The ZIP itself
  stays the owner's download surface; the extraction is for the agent.
- **`index.json` is not updated** by either tool, same as the document tools,
  so the boot audit may report extracted files as unindexed. Nothing is
  deleted by the audit. The BFF's upload quota is index-based, so it does not
  see extracted bytes; the archive tool's own sum is the conservative bound
  (an extraction cannot cross 100 MiB, and a later upload is not told about
  the folder).
- **File ownership.** The tools run in the agent container, so extracted
  directories and files are owned by the agent user with 0700/0600; the BFF
  (a different uid on the shared volume) cannot read them. That matches the
  DOCX/PDF files written by `documents_fill`; the archive card is the owner's
  copy.
- **No password support, no split archives, no ZIP64 beyond what `zipfile`
  handles, no rename-on-collision, and no malware scan.** Encryption is
  refused, collisions are refused, and "not a virus scanner" from
  [`23-uploads.md`](23-uploads.md) still holds.
- **No `.tar`, `.tar.gz`, `.7z` or `.rar`.** One format, one reader.
