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
  - `facts.jsonl` — one atomic fact per line, append-only; a write never
    rewrites an existing line. Fields: `id`, `kind` (`preference | profile |
    project | decision | episode | snippet`), `text`, `topic`, `tags`, `source
    { sessionID, messageID, at }`, `trust` (`explicit | observed | inferred`),
    `status` (`active | superseded | expired | deleted`), `supersedes[]`,
    `createdAt`, `lastConfirmedAt`, `expiresAt`, `checksum`.
  - `INDEX.md` — the push layer: topic, ID ranges, one line per fact, hard-capped
    (~400 tokens target) and trimmed by rank, never mid-sentence.
  - `audit.jsonl` — every write/update/delete/prune with actor, time and reason.
- Directory `0700`, files `0600`. A directory needs the execute bit to be
  traversable by `node`, so `0600` on the directory would break it.
- **The BFF is the only writer.** `memory-data` is mounted read-write in the
  BFF only; the MCP server never writes the volume directly and OpenCode gets no
  memory mount at all. The BFF image pre-creates the mount point, `chown
  node:node` and `chmod 700` it before the volume is used, so a fresh volume is
  owned by the same UID that writes every file. An optional read-only visibility
  mount for OpenCode is deferred to a later step; it is deliberately not present
  here so a root-mounted volume can never seed files the BFF cannot write.
- All writes are atomic; corrupt lines are skipped on read and logged to
  `audit.jsonl`. Writes exist only through the internal route below.

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
| `GET /api/memory` | `{ facts, audit, index }` — all statuses, the audit trail and the current index content |
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
pre-date the restart therefore receive the refreshed index too. Host-created
child sessions (subagents, schedules) do not go through
the BFF create route; backfilling those via a `session.created` listener is a
tracked gap, not part of this slice. The bare `session.instructions.*` surface
is deprecated — use the `experimental.` namespace.

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
  run returns ranked candidates with reasons and applies nothing. Compaction
  does not delete memory — it lives outside session history.

## Clean-room write boundary

`mem_write` and `mem_update` reject at the boundary: reference-product branding
and names, paths under `references/raw/` or quoted third-party prompts/UI text,
secret-like patterns and instruction-like payloads — memory is data, never
directives, and retrieved memory is never treated as instructions. A rejection
returns a clear error to the caller and writes nothing; accepted mutations and
corrupt-line skips are recorded in `audit.jsonl`. The store is kept secret-free
so the blast radius of any future writable mount stays bounded.

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

- **Store:** atomic append, upsert, supersession links, TTL transitions, prune
  dry-run ranking, corrupt-line recovery and cap trimming; internal-route auth
  (`MEMORY_INTERNAL_TOKEN`); fresh-volume bootstrap against a **truly empty**
  volume — ownership `node:node`, directory `0700`, files `0600`.
- **HTTP contracts:** internal ops map to store actions with token auth and no
  public exposure; public `GET`/`PATCH`/`DELETE` (with `{ reason }`)/`export`
  go through the single writer; delete never hard-removes.
- **Tool contract:** batch shapes, dedupe before write, secret/instruction-payload
  and branding rejection, compact-JSON limits, and each tool issuing the correct
  `op`.
- **Injection (fake):** a new session gets the `memory.index` entry; a store
  change re-puts it for active sessions; a superseded fact disappears from the
  push layer; the key is slash-free; host put failures never fail session
  creation.
- **UI:** `/memory` browse/edit/delete/export/audit, plain-text rendering and
  keyboard reachability; `en`/`de` strings present with no hard-coded text.
- **E2E (fake backend):** write a fact via the fake memory tool, start a new
  chat, assert the injected index contains it; supersede it and assert the old
  line is gone from the push layer.
- Gates before any commit: `pnpm run gates:fast` (lint, typecheck, test, build,
  `ratchet check --tier fast`).
