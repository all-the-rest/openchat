# 22 — Per-chat working files

**Status:** 2026-11-18. Implements issue #25 (M3). Transport for uploads and
downloads stays in #21; this slice is the storage layout, the session-scoped
metadata and the compact chat list.

## Layout

```text
<WORKSPACE_DIR>/chats/
  <sessionID>/
    index.json          { version: 1, files: ChatFileInfo[] }
    files/              the bytes, 0700
      quarterly.docx    0600
      quarterly-1.docx  collision suffix, never an overwrite
```

Directories are created on the first accepted write and both levels are
`chmod`-ed to 0700, so a pre-existing directory cannot keep looser bits; new
files are created 0600. Reading a chat that has
no directory returns an empty list and creates nothing; a chat that never
uploaded or received an agent file has no directory at all.

`index.json` is written through a sibling temporary file and renamed into
place, so a crash leaves a `.index.json.*.tmp` file at worst, never a half
index. A missing or malformed index reads as an empty list; the boot audit
then reports the files that are left without metadata.

## Endpoints

All four are session-scoped and sit behind the existing `/api/*` auth guard.

| Route | Result |
| --- | --- |
| `GET /api/sessions/:id/files` | `{ files, quota }` — newest first, `Cache-Control: no-store` |
| `GET /api/sessions/:id/files/:name` | The exact bytes as `attachment`, stored MIME, `nosniff` |
| `POST /api/sessions/:id/files?name=<name>` | Raw body; the name is a query parameter, never a header |
| `DELETE /api/sessions/:id/files/:name` | `204`; `404` for a name that is not indexed |

`ChatFileInfo` is `{ name, displayName, size, mtime, mime, origin, sha256 }`:
the stored name, the owner-facing name (equal unless a collision added a
suffix), the filesystem size and mtime, the type derived from the stored
extension, `upload` or `agent`, and the SHA-256 of the exact bytes. No
filesystem path crosses the wire.

`ChatFileQuota` reports the chat's used and configured bytes plus the same two
numbers for the whole workspace. The chat list renders that as one progress bar
and a text line, so the limit the server enforces is the number the owner sees.

## Path rules

The name is one path segment or the write is rejected — no rewriting:

- no `/` or `\`, so absolute paths and nested paths fail;
- not `.` or `..`, and no leading dot, so traversal and dotfiles fail;
- no control characters, no surrounding whitespace, at most 200 code points;
- session ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, so an id is always
  one directory name.

After every join the resolved path is checked to sit directly inside its
parent, and each read checks `lstat`: regular file, not a symlink, exactly one
hard link. Uploads open with `O_CREAT | O_EXCL | O_NOFOLLOW`, so an existing
symlink at the target name is never followed and never overwritten; the store
moves to the next free suffix (`-1`, `-2`, …) instead.

The directory is never served by a static handler: only `WEB_DIST_DIR` is, and
`WORKSPACE_DIR` is not under it in any supported deployment.

## Quotas

| Variable | Default | Why |
| --- | --- | --- |
| `WORKSPACE_QUOTA_PER_CHAT_BYTES` | 104 857 600 (100 MiB) | Fits a filled Office template, PDFs and generated images without letting one chat hoard a volume. |
| `WORKSPACE_QUOTA_TOTAL_BYTES` | 1 073 741 824 (1 GiB) | Bounds the workspace while leaving room for ten full chats. |
| `WORKSPACE_MAX_FILE_BYTES` | 26 214 400 (25 MiB) | Matches the dictation cap and covers any DOCX/PDF a chat produces; clamped to 100 MiB. |

A non-integer or non-positive value falls back to the default with one boot
warning. A per-chat quota above the total is accepted but warned about, because
the total then rejects the write first.

Both quotas are checked **before** the directory chain is created. An upload
that would cross either limit returns `413` and leaves no directory, no
temporary file and no metadata row. A single file above
`WORKSPACE_MAX_FILE_BYTES` is `413 payload_too_large`; a bad name is `400`; a
collision that exhausts 99 suffixes is `409`.

Writes are serialised in-process, so two uploads cannot both pass the quota
check against the same starting number. Index sizes are the accounting source;
a file placed in `files/` without an index row does not count and is reported
by the boot audit instead.

## Boot audit

`reportChatFileOrphans` runs once after boot, when the host has answered its
session list. It logs:

- chat directories whose id is not in the session list;
- files in `files/` without an index row;
- index rows whose file is missing.

It never deletes. A host that is offline at boot logs nothing and does not
block the listen; the audit is a hygiene signal, not a repair job.

## Chat deletion

`deleteChatFiles(workspaceDir, sessionID)` removes exactly one chat directory
after resolving it and checking that it is a direct child of `chats/`. A chat
directory replaced by a symlink is refused. There is no session-delete route
yet, so the function is the hook for the slice that introduces one; the tests
pin that deleting one chat leaves every other directory untouched.

## UI

`ChatFiles` sits between the chat header and the transcript and appears only
when the session owns at least one file. Each row shows name, size, origin
badge, a same-origin download link and a delete button. Delete opens a daisyUI
modal (`role="alertdialog"`, Escape and Cancel close it) and reloads the list
after the `204`. The quota bar sits on the section header line. While a
different session loads, the previous response is never rendered.

Labels live in `apps/web/src/i18n/messages/files.ts`; the German text lives in
the PO catalogue, and the compiled bundles are regenerated with
`pnpm --filter @openchat/web i18n:compile`.

## Deliberately left out

- Upload transport (drag/drop, magic-byte type check, prompt attachment
  reference) — issue #21. The BFF accepts a raw body so the storage path exists
  and its `413`/`400` behaviour is testable; the MIME type is derived from the
  stored extension until #21 adds sniffing.
- An event-driven refresh of the list when the agent writes a file in the
  background. The list reads once per chat open and after a delete.
- A cleanup action for old chats: there is no chat deletion in the UI yet, and
  the boot audit deliberately never deletes.
- An agent-facing tool that writes into `files/`. `ChatFilesStore.write(...,
  origin: "agent")` is the path such a tool uses; the tool itself belongs to
  the tool-surface slice.
