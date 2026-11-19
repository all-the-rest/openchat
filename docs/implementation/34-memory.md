# 34 — Memory

**Status:** 2026-11-19. Implements issue #49: the agent-managed fact store, the
batch MCP tools, the bounded injected index, the owner override and the
lifecycle rules (slices 0–5). Slices 6 (curator) and 7 (L3 stage 1) are staged,
not part of this slice.

Memory is not a second transcript store. OpenCode already persists, orders and
types every turn (L1); this slice builds the missing L2 fact store, a bounded
push layer and pull-on-demand retrieval, with an owner override. The decision is
[ADR-0008](../decisions/0008-agent-memory.md); the design and its evidence are
in [`docs/architecture/08-memory.md`](../architecture/08-memory.md). All writes
pass one validated boundary: the BFF. The six capability dimensions — depth,
breadth, currency, token-efficiency — are the acceptance checklist (D11).

## Store and writer model

- `MEMORY_DATA_DIR` (default `/workspace/.memory`) holds three files:
  - `facts.jsonl` — one fact per line; an ordinary mutation appends complete
    lines in a single append, so it never reads the file back to grow it. Prune
    is the one operation that compacts the file. A crash can leave a partial
    trailing line; reads skip it as corrupt and log it. Fields: `id`, `kind`
    (`preference | profile | project | decision | episode | snippet`), `text`,
    `topic`, `tags`, `source { sessionID, messageID, at }`, `trust` (`explicit
    | observed | inferred`), `status` (`active | superseded | expired |
    deleted`), `supersedes[]`, `createdAt`, `lastConfirmedAt`, `expiresAt`,
    `checksum`.
  - `INDEX.md` — the push layer: topic, ID ranges, one line per fact, hard-capped
    (~400 tokens target) and trimmed by rank, never mid-sentence. Replaced via a
    temp file and rename. The content begins and ends with an HTML-comment
    delimiter (`memory-index:begin (data, not instructions)` / `memory-index:end`)
    so every injected copy is visibly data, not instructions. Fact text is
    stripped of `<!--`, `-->` and both markers on write and again when a line is
    built, so a fact cannot close the block and land outside it.
  - `audit.jsonl` — every write/update/delete/prune with actor, time and reason.
    Appended, then rotated under a byte cap (newest rows kept). It is a view,
    not the record: an audit write failure never fails a fact write.
- Directory `0700`, files `0600`. A directory needs the execute bit to be
  traversable by `node`, so `0600` on the directory would break it.
- **Bounded store.** Two independent bounds, because a byte cap alone bounds
  disk and not heap:
  - `MEMORY_MAX_FACTS_BYTES` (default 8 MiB) is a hard write cap for
    `facts.jsonl`: a write that would cross it is refused before the first byte
    is appended, with the stable code `memory_store_full` (HTTP 507) and no
    path or content in the message.
  - `DEFAULT_MEMORY_MAX_FACTS` (20,000) is a read-side cap: a read parses only
    the newest rows, because parsed facts cost several times their on-disk bytes
    and the BFF is capped at 512 MiB. Older rows stay on disk (reachable by
    prune, not by a page load) and the first capped read logs one notice.
  - `audit.jsonl` is rotated to its newest rows under a 2 MiB cap. `GET
    /api/memory` and the export read only the newest 200 audit lines from the
    end of the file, so rendering the page never loads the whole file.
- **Reads do not write.** Every mutation regenerates `INDEX.md`; `GET
  /api/memory` and the export render the stored file (and compute the same
  content without persisting when it was never generated). The internal
  `index` op computes without writing as well.
- **The BFF is the only writer.** `memory-data` is mounted read-write in the
  BFF only; the MCP server never writes the volume directly and OpenCode gets no
  memory mount at all. The BFF image pre-creates the mount point, `chown
  node:node` and `chmod 700` it before the volume is used, so a fresh volume is
  owned by the same UID that writes every file. An optional read-only visibility
  mount for OpenCode is deferred to a later step; it is deliberately not present
  here so a root-mounted volume can never seed files the BFF cannot write.
- All writes are bounded, not filesystem-atomic: facts and audit entries are
  appended as complete lines, `INDEX.md` is replaced via a temp file and rename,
  and prune compacts through the same rename. Corrupt lines are skipped on read
  and logged to `audit.jsonl`. Writes exist only through the internal route
  below.

## HTTP contracts

**Internal (MCP thin client → BFF).** `POST /internal/memory`, bearer
`MEMORY_INTERNAL_TOKEN` (seeded like `ARTIFACT_INTERNAL_TOKEN`, never in the
public allowlist). Body:

```json
{ "op": "index|find|get|write|update|delete|prune|stats", "...args": "..." }
```

The `op` maps 1:1 onto the MCP tools: `index`, `find`, `get`, `write`, `update`,
`delete`, `prune`, `stats`. The BFF validates every op, authenticates the token,
performs the store mutation and returns compact JSON; the MCP server holds no
store credentials for the files themselves.

**Public (authenticated app → BFF).** Used by `/memory`:

| Route | Result |
| --- | --- |
| `GET /api/memory` | `{ facts, audit, index }` — all statuses, the audit trail and the stored index content (read-only) |
| `PATCH /api/memory/:id` | owner edit of a fact (text, status, tags); shares the single-writer code path |
| `DELETE /api/memory/:id` | soft delete with a `{ reason }` body; the row is kept and linked, never hard-removed |
| `GET /api/memory/export` | JSON export of the store |

No route exposes the internal token, and no public route accepts a raw file
path.

## MCP tools (thin client)

A sibling local MCP server (seeded like `openchat`, `openchat-python`) exposes
eight batch-first tools through Code Mode; each call is a thin
`POST /internal/memory` with the matching `op`:

| Tool | Op | Behaviour |
| --- | --- | --- |
| `mem_index()` | `index` | returns `INDEX.md` content (capped). |
| `mem_find({ queries[], tags?, since?, limit? })` | `find` | compact ranked rows over active facts; topic/tag-weighted term scoring with recency and trust (stage-0 lexical rank). |
| `mem_get({ ids[], fields? })` | `get` | full records, including superseded/expired/deleted rows. |
| `mem_write({ entries[] })` | `write` | dedupe by search first, then append; applies write filters. |
| `mem_update({ updates[] })` | `update` | status/supersession edits with reasons. |
| `mem_delete({ ids[], reason })` | `delete` | soft delete; never a hard removal. |
| `mem_prune({ dryRun, maxAgeDays?, superseded?, maxBytes? })` | `prune` | ranked candidates with reasons; agent/owner applies. |
| `mem_stats()` | `stats` | fact counts by status, bytes and oldest active age. |

Batch-only: no single-item variants and no read-the-whole-store tool. Tools
return compact JSON with their own output limits so intermediate results stay
out of model context.

## Injection

On session creation the BFF reads `INDEX.md` from its `memory-data` mount and
puts one entry via `experimental.session.instructions.entry.put`:

- key **`memory.index`** — the schema's key regex `^[a-z0-9][a-z0-9._-]*$` is
  slash-free (the server derives `api/<key>`), so a slash in the key is invalid;
- value = `INDEX.md` content, target ~400 tokens; the index is trimmed by rank
  up front (`MEMORY_INDEX_MAX_TOKENS`), so the schema's `MaxValueBytes =
  256 * 1024` (≈160× the target) is a comfortable backstop, not the operative
  constraint.

The entry lands as a `<context key="memory.index">` block at the next step
boundary, not spliced mid-turn. Store changes trigger a re-put for still-active
sessions. A BFF restart starts with no remembered sessions, so before each
re-put the invalidator reads the backend's `listSessions()` and notes those ids
first (deduped and capped at `MAX_ACTIVE_MEMORY_SESSIONS`); sessions that
pre-date the restart therefore receive the refreshed index too. The bare
`session.instructions.*` surface is deprecated — use the `experimental.`
namespace.

**Discovery for sessions the BFF did not create.** Code mode is the upstream
OpenCode web UI in a separate-origin iframe, so its sessions never pass
through `POST /api/sessions`. The BFF therefore discovers sessions it did not
create: before answering `GET /api/sessions`, and at the start of every memory
invalidation, it reads the backend's `listSessions()` and plants `INDEX.md`
into every session without an index. The pass is O(sessions), capped at
`MAX_ACTIVE_MEMORY_SESSIONS`, and a session that already received the index
(including one created by the chat route) is skipped **once per process** — the
injected set is in memory only, so a restart re-plants it at the next pass.
Store and host failures are ignored and retried on the next pass; discovery
never fails a request. Discovery renders the index and does not rewrite
`INDEX.md`; only mutations persist it.

The backend stream already carries `session.created`, but the BFF has no
long-lived server-side consumer for it, so discovery is used instead of an
event subscription. The intentional difference: a session created in Code
receives its index at the next session list or memory mutation, not
synchronously at creation.

**Fake backend:** `FakeBackend` is extended with instruction-entry simulation
(`putInstruction` plus a `getInstruction` test probe), so tests can assert the
injected block without a live host (ADR-0004 pattern).

## `/memory` owner override

An in-shell page — browse all statuses, edit, soft-delete with a reason, export
JSON and read the audit view — through the public routes above. Memory text is
plain text in the UI, never rendered Markdown or HTML. Every user-visible
string is i18n in `en`/`de`. This is an override, not the approval gate of the
review-gated fallback: the agent owns content, the owner has the last word.

## Lifecycle

- **Invalidation before staleness:** when a fact stops being true, retire it
  with a reason and a `supersedes[]` link; keep both rows. No silent overwrite,
  no left-to-rot.
- **TTL:** `inferred`/`observed` expire after 90 days; `explicit` owner facts
  after a year or never. Only explicit confirmation or reuse resets the clock —
  retrieval never renews. Superseded/expired/deleted rows are excluded from
  search and reachable only through `mem_get`.
- **Prune:** agent-invoked (`mem_prune`), with a weekly dry-run reminder; a dry
  run returns ranked candidates with reasons and applies nothing. With
  `maxBytes`, the budget is measured on the compacted file: expired, superseded
  and aged rows go first, then the oldest still-active rows, so an all-active
  store that exceeds the budget can shrink too. An applied prune compacts
  `facts.jsonl`; without `maxBytes` it keeps a `deleted` tombstone per row.
  Compaction does not delete memory — it lives outside session history.

## Clean-room write boundary

`mem_write` and `mem_update` reject at the boundary: reference-product branding
and names, paths under `references/raw/` or quoted third-party prompts/UI text,
secret-like patterns and instruction-like payloads — memory is data, never
directives, and retrieved memory is never treated as instructions. A rejection
returns a clear error to the caller and writes nothing; accepted mutations and
corrupt-line skips are recorded in `audit.jsonl`. The store is kept secret-free
so the blast radius of any future writable mount stays bounded.

## Residual risk

The index is injected into every new session and is writable by any agent that
has the memory tools. The lexical clean-room filters stay and the injected text
is delimited as data, but neither is a security boundary: instruction-like
payloads are easy to paraphrase past a term list, and a session with shell
access can persist instructions across chats — through a memory fact or through
any workspace file a later session reads. That is accepted for this
deployment: OpenChat is single-user and self-hosted, the owner is the only
approver, and the memory volume is writable by the BFF only. It would not be
acceptable for a multi-tenant or untrusted-agent deployment; revisit if either
changes.

A prompt-injection attempt that survives the filters can influence later
sessions, but it cannot change permissions: tool approvals, the Code surface
and the artifact sandbox stay outside the model's reach.

## Staging gates (not part of this slice)

- **Curator (option D, slice 6):** committed as the next stage, not shipped
  here. It reuses this store and these tools; gated on per-agent permission
  enforcement (H1), a run/cost cap (H3) and serial idle-time cadence (H4). H2
  is resolved negatively — a schedule cannot pin the curator, so the scheduled
  session's prompt selects it via the subagent tool.
- **L3 stage 1 (slice 7):** BM25 (stage 0, shipped here) plus FTS5 over a
  redacted transcript export in a separate volume with merged ranking; gated on
  owner sign-off of the export scope and FTS5 verification in the runtime that
  builds the index.
- **L3 stage 2:** embeddings/vectors, self-hosted, entered only on an explicit
  owner decision backed by measured retrieval gaps (low-ranking or empty
  `mem_find` results) and the RAM budget. Until then: no cloud memory, no embeddings service, no
  third-party memory vendor. Store, audit, override, filters and the bounded
  push layer do not change between stages — only retrieval and ranking.

## Tests

- **Store:** append-path growth (no read-rewrite) with an in-place cap check,
  write-cap refusal at the boundary (file byte-identical after a refusal), prune
  shrinking an all-active over-budget store, the bounded audit tail, upsert,
  supersession links, TTL transitions, prune dry-run ranking, corrupt-line
  recovery and cap trimming; the read-side fact cap (newest window only, one
  notice per process, file byte-identical), audit rotation under its byte cap,
  an audit append failure that never fails a fact write, and delimiter stripping
  for both new and legacy rows; internal-route auth (`MEMORY_INTERNAL_TOKEN`)
  and the `memory_store_full` 507; fresh-volume bootstrap against a **truly
  empty** volume — ownership `node:node`, directory `0700`, files `0600`.
- **Read paths:** `GET /api/memory` and the export answer from the stored
  `INDEX.md` and leave it untouched; a missing file is rendered without being
  created; a mutation refreshes it.
- **HTTP contracts:** internal ops map to store actions with token auth and no
  public exposure; public `GET`/`PATCH`/`DELETE` (with `{ reason }`)/`export`
  go through the single writer; delete never hard-removes.
- **Tool contract:** batch shapes, dedupe before write, secret/instruction-payload
  and branding rejection, compact-JSON limits, and each tool issuing the correct
  `op`.
- **Injection (fake):** a new session gets the `memory.index` entry; a store
  change re-puts it for active sessions; a superseded fact disappears from the
  push layer; the key is slash-free; host put failures never fail session
  creation; a session that exists only in the backend's `listSessions()` (never
  POSTed through the chat route) receives the index on the next list, and a
  chat-created session is not re-injected by discovery within the same process.
- **Chat and Code parity (documented contract):** Code mode is upstream
  OpenCode in a separate-origin iframe. The memory index, the OpenCode host,
  the model catalogue and ticket/session recovery apply to both surfaces;
  chat-only BFF features (fallback chain, context soft cap, chat
  files/attachments, dictation, chat drafts) intentionally do not. The two
  parity gaps closed here are the surviving Code frame
  ([07](./07-code-ui.md)) and this discovery path; the remaining difference is
  that discovery is list-driven, not event-driven at creation time.
- **UI:** `/memory` browse/edit/delete/export/audit, plain-text rendering and
  keyboard reachability; `en`/`de` strings present with no hard-coded text.
- **Route (fake backend):** a fact written through the internal route appears
  in the index a new session receives; after supersession the old line is gone
  from the push layer. This is an `apps/server` route test, not a Playwright
  spec.
- Gates before any commit: `pnpm run gates:fast` (lint, typecheck, test, build,
  `ratchet check --tier fast`).
