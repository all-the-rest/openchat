# ADR 0008 — Agent-Managed Memory with a Bounded Injected Index

**Status:** accepted for 2.5 (2026-11-19)
**Deciders:** owner, orchestrator

## Context

Every chat session currently starts with no knowledge of the owner: the host
OpenCode persists transcripts (L1) but has no memory API, and this repo has no
facts store (L2), no retrieval layer (L3), no memory route, tool or UI. The
tracker and the docs disagree on what to build — issue #49's body still
describes an older, review-gated `memory.json` design while the owner's comment
on the same issue records the pivot to an agent-managed, file-based store.
`docs/architecture/08-memory.md` closes that analysis: it sets the quality bar
(depth, breadth, currency, token-efficiency), scores four options, and commits
L3 as a *staged* target after the owner corrected an earlier v1-only reading of
the research. The builder role reads only `docs/spec/**`,
`docs/architecture/**`, `docs/decisions/**` and `features/**`, so without this
decision it would build the wrong design.

The product is not live (version 2.2.0), so nothing already shipped constrains
the choice and the previously "decided" review-gated shape may be reopened.

## Decision

1. **Option B — file-first, agent-managed store.** Adopt the
   file-first agent-managed store plus local MCP thin client, bounded pushed
   index and `/memory` owner override described in
   [`docs/architecture/08-memory.md`](../architecture/08-memory.md) (§5, §6).
   The store lives at `MEMORY_DATA_DIR` (default `/workspace/.memory`) with
   `facts.jsonl` (append-only atomic facts), `INDEX.md` (the push layer) and
   `audit.jsonl` (every mutation); the directory is `0700` and the files `0600`.
   Every fact carries kind, trust, status, provenance, timestamps and a
   checksum. Kinds are `preference | profile | project | decision | episode |
   snippet`; trust is `explicit | observed | inferred`; status is `active |
   superseded | expired | deleted`.

2. **Single-writer BFF model.** The BFF is the only process that touches the
   store files. `memory-data` is mounted read-write in the BFF only; the local
   MCP server is a thin client that writes through the BFF's internal bearer
   route (`POST /internal/memory`, `MEMORY_INTERNAL_TOKEN`), never directly.
   The optional read-only visibility mount in OpenCode is added only after the
   fresh-volume bootstrap (`chown node:node`, `chmod 700`) has run. This avoids
   the split-UID trap (BFF as `node`, OpenCode/MCP as root).

3. **Batch MCP tools.** Eight batch-first tools — `mem_index`, `mem_find`,
   `mem_get`, `mem_write`, `mem_update`, `mem_delete`, `mem_prune`, `mem_stats`
   — seeded as a sibling local MCP server and exposed through Code Mode. They
   are called through `POST /internal/memory` with
   `{ op, ...args }`; there is no read-the-whole-store tool.

4. **Bounded injection.** On session creation the BFF pushes one
   `experimental.session.instructions.entry.put` entry keyed **`memory.index`**
   (the schema's key regex is slash-free), value = `INDEX.md`, hard-capped
   (~400 tokens target; `MaxValueBytes = 256 * 1024` is the defensive
   backstop), trimmed by rank and re-put on store changes. Pull-on-demand uses
   `mem_find` / `mem_get`. The bare `session.instructions.*` surface is
   deprecated; code and docs use the `experimental.` namespace.

5. **Owner override, not approval gate.** `/memory` is a browse/edit/delete/
   export/audit view inside the app shell with one i18n set in `en`/`de`. The
   agent owns content; the owner keeps the last word. Memory text is plain text
   in the UI, never rendered as Markdown or HTML.

6. **Lifecycle as hard rules.** Supersession links instead of silent overwrite;
   TTL of 90 days for `inferred`/`observed` and a year-or-never for `explicit`;
   confirmation-only renewal (retrieval never renews); agent-invoked prune with
   a weekly dry-run reminder; full audit. Write-boundary filters reject
   reference-product branding, reference paths, secrets/PII and instruction-like
   payloads, and log rejected encounters.

7. **L3 is staged, not discarded.** Stage 0 ships with B: BM25 over
   `facts.jsonl` (`mem_find`) plus the injected index. Stage 1 (lexical hybrid)
   adds FTS5 over a redacted transcript export in a separate volume with merged
   ranking — the next slice after `/memory`, on owner sign-off of the export
   scope. Stage 2 (embeddings/vectors, self-hosted) is entered **only** on an
   explicit owner decision backed by measured lexical misses and a RAM budget;
   until then the v1 rule stands: no cloud memory, no embeddings service, no
   third-party memory vendor.

8. **Accept the D1–D11 defaults.** D1 separate `memory-data` volume, BFF-only
   writer (single-writer model). D2 ~400-token push budget. D3 adopt the
   verified `experimental.session.instructions.entry.*` API. D4 agent-invoked
   prune plus weekly dry-run reminder. D5 base 2.5 = B with the curator (option
   D) committed as the next stage. D6 full clean-room rejection list at
   `mem_write`. D7 extend `FakeBackend` with instruction entries. D8
   documentation closure in slice 0 (blocking). D9 FTS5 export as the L3
   stage-1 shape. D10 add `agent`/`model` to the contract with the provenance
   slice (free while greenfield). D11 make §1.1 of the architecture the explicit
   acceptance checklist.

9. **Option A is a named emergency fallback, not a compatibility path.** The
   review-gated single-file design (`memory.json`, `memory_propose`,
   `status: proposed | approved | archived`, BFF-only writer, approval gate)
   stays available on the same file format — `status: proposed` is already
   supported — if agent-managed writes must be suspended. Migrating the store
   is not required to switch to it.

## Consequences

- The agent can poison the store; this is mitigated, not eliminated, by write
  filters, TTL, audit and the `/memory` override. The single-writer mount (the
  BFF is the only process with the `memory-data` volume, and the agent tools are
  thin clients through its internal route) is the primary boundary; explicit
  host permission rules for `.memory/**` are a later hardening step, not part of
  this slice.
- One more MCP package, BFF injection code and the `/memory` UI are added; a
  sixth backup source and a compose `memory-data` volume join deployment.
- B reaches the token-efficiency and simplicity bars; depth, breadth and
  currency at the §1.1 level require the curator (option D), which is committed
  as the next stage behind verification gates H1/H3/H4 (H2 is resolved
  negatively: a schedule cannot pin the curator).
- L3 stage changes touch retrieval and ranking only; store, audit, override,
  filters and the bounded push layer stay constant across stages.
- Token cost is bounded and measurable: ~400 always-on tokens, pull on demand.
- The curated store stays plain text, diffable and backup-able with no new
  database service and no third-party memory vendor.
- Documentation closure (this ADR, the spec section, the roadmap entry and the
  issue #49 rewrite) must complete before implementation — the builder reads
  only the docs named above.

## Alternatives rejected

- **Option C — full vector/RAG pipeline.** Not rejected outright but deferred
  to L3 stage 2 behind an explicit owner decision; v1 has no measured lexical
  misses, it would need a host plugin the stack deliberately avoids, and it
  conflicts with the current non-goals on embeddings services.
- **Option A as the primary design.** Owner-controlled but starves in practice
  (the agent cannot learn without approval work), costs ~1 500 always-on
  tokens and contradicts the owner direction on record. Retained only as the
  named emergency fallback above.
- **Option D as the base slice.** Highest quality but most complex; its
  per-agent permission enforcement, run cost and concurrency/RAM hypotheses
  (H1/H3/H4) are open. Committed as the stage after B, not the starting slice.
- **Rebuilding L1 in an app-owned database.** The host already persists, orders
  and types transcripts; duplicating them adds cost and a consistency problem,
  and re-ingesting the agent's own output as trusted violates the clean-room
  and untrusted-input rules.
