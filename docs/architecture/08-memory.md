# 08 — Agent Memory

**Status:** design document, 2026-11-18. No implementation exists; this page
contains no production code and commits to no implementation — it does commit
option D as a *stage* of the plan (§5, §8). Decision-ready input for
milestone 2.5, tracked as issue #49 (`all-the-rest/openchat`). The project is
at `VERSION` 2.2.0 (`CHANGELOG.md:8`) and **the product is not live** —
nothing ships yet, so no earlier decision constrains this design by
compatibility (§1.2). The memory question is a growth decision, not a
first-release decision.

**Evidence base:** repository sources cited as `path:line`; the host API surface
as documented in `docs/architecture/02-opencode-integration.md` (verified against
`@opencode/client@2.3.x` declarations); the research survey
`docs/research/agent-memory.md`; GitHub issue #49 (body + owner comment); and a
read-only schema inspection of a real OpenCode 2.3.x SQLite database (§2.4 —
observed schema evidence, **not** this project's deployment DB). Anything not
covered by those sources is marked `RISK` or `HYPOTHESIS`.

**Owner correction (2026-11-18, applied to this revision):** do not discard
Layer 3 (semantic memory bank). The anti-pattern/non-goal wording in the
research note (`docs/research/agent-memory.md:54-60, 188-193`) was a **v1
decision, not a permanent verdict** — the project is at 2.2.0. Layer 3 is
presented here as a legitimate, staged target: start with hybrid lexical,
high-quality retrieval over OpenCode's own data, then grow into
embeddings/vectors when justified. This page reflects that correction; it does
not claim the research recommended never building the semantic layer.

**Owner clarifications (2026-11-18, folded into this final revision):**

1. **Quality bar.** Memory must reach the capability of best-in-class chat
   assistant chat-mode memory — very high depth, breadth and currency at very
   low token cost (§1.1). No reference-product brand name appears in this
   document; evidence stays generic, per the clean-room rule
   (`AGENTS.md:8-13`).
2. **Greenfield freedom.** The product is not live; previously "decided"
   artifacts (issue design, contract fields, compose mounts, seed, roadmap) may
   be reopened — nothing has to be migrated (§1.2).
3. **Design qualities.** Very intelligent, very easily extensible, low
   technical overhead: plain files, documented host APIs and the existing
   local-MCP pattern over new platforms or database services (§1.3, scored as
   explicit criteria in §5).

---

## 1. Scope and status

1. **Design only.** One document; no code, no config change, no new package.
2. **Separate what is true in this repo from what the commissioning prompt
   assumed.** The original brief for this work came from a foreign,
   Google-based agent toolkit, not from OpenChat. Four of its assumptions do
   not hold here and would have mis-led the design (§3).
3. **Assess the 3-layer concept** (L1 transcripts / L2 facts / L3 semantic
   bank) against what the OpenCode host already owns, and against the owner's
   staged direction for L3 (§3.3, §4).
4. **Name the blocking documentation gaps** — the tracker and docs do not yet
   agree on what is being built (§4.4). Those gates close before any code.
5. **Recommend one architecture** (§5–§6) with named alternatives, open owner
   decisions with defaults (§7), and a slice sequence (§8).
6. **Hold every option to the quality bar** (§1.1) and the design qualities
   (§1.3) — an option that cannot structurally reach the bar is not an option.

### 1.1 Quality bar — what "good memory" means here

Owner requirement: memory as capable as **best-in-class chat assistant
chat-mode memory**. No product is named here; the research survey records the
*observable behaviours* of that class — curated stores, ranked injection,
review UI, expiry, citations (`docs/research/agent-memory.md:29-39, 43-52`) —
and those behaviours are the bar. Four dimensions, all mandatory:

| Dimension | Means | Demands of the design |
| --- | --- | --- |
| **Depth** | atomic facts **plus** episodes (what happened, when, in which session) **plus** decisions, each with provenance | a record model with kinds and provenance fields, not just strings; supersession links (§6.1) |
| **Breadth** | preferences, project context, solved problems, code/snippets, past conclusions — more than "prefers German UI" | kinds `preference / profile / project / decision / episode / snippet`; extraction from L1, where compaction rows are pre-digested episodes (§2.4); snippets with back-references |
| **Currency** | supersession, TTL, explicit confirmation, **invalidation instead of staleness** — a fact that stopped being true is retired with a reason | the lifecycle rules of §6.6 as hard requirements; confirmation resets the clock, retrieval never does; full audit |
| **Token-efficiency** | bounded injected index, pull-on-demand, batch tools, no prompt monolith | the two-layer split: push index ~400 tokens, pull via `mem_find`/`mem_get` (§6.2–6.4) |

The bar is the acceptance criterion for the whole feature (D11): each slice in
§8 states which dimension it advances.

### 1.2 Greenfield posture — nothing ships yet, everything decided is reopenable

No user has data in any store, no release carries a memory file, and the only
"decided" artifacts are documents, an issue body and deployment defaults.
**No backward compatibility constrains this design.** What should be reopened,
and the recommendation:

| Reopen | Was | Recommendation under greenfield |
| --- | --- | --- |
| Issue #49 body | review-gated `memory.json`, approval gate, ~1 500 tokens | **Replace** with the agent-managed design (B, then staged D); the review-gated shape survives only as a named emergency fallback, not a compatibility path (§4.4 G5) |
| `SessionInfo` / `Message` fields | drop the host's per-session `agent`/`model` (§2.4, weakness 4) | **Add the fields with the provenance slice** — no migration cost while nothing ships (D10) |
| BFF compose mounts | workspace read-only, `chat-files` writable subtree (`compose.yaml:85-91`) | **Adjust freely**: a `memory-data` volume at `/workspace/.memory` — read-write in the BFF, optional `:ro` visibility in OpenCode only after bootstrap (D1) — reuses the existing pattern; no deployed stack migrates |
| Deploy seed | two local MCP servers + compaction (`deploy/remote/seed-config.sh:122-156`) | **Extend** with the memory tool entry; the never-rewrite-an-existing-config behaviour stays (`seed-config.sh:91-104`) |
| Roadmap / milestone | no memory milestone anywhere (§4.4 G3) | **Set it now**: 2.5 substrate, curator and lexical-hybrid as committed follow-on slices |
| v1 non-goals / anti-patterns wording | `docs/research/agent-memory.md:54-60, 188-193` | **Re-scoped, not overturned**: they govern how the first slice is built; the staged L3 path (§4.3, §6.11) is the standing correction |

### 1.3 Design qualities — the evaluation frame

Each option in §5 is scored on four explicit criteria:

1. **Intelligence/depth** — how far the option structurally reaches toward the
   §1.1 bar: who curates, who resolves conflicts, what quality of extraction.
2. **Extensibility** — how cheaply the next stage (curator, lexical hybrid
   over L1, embeddings) bolts on without redesign.
3. **Operational simplicity** — "low technical overhead": plain files,
   documented host APIs, the existing local-MCP pattern over new platforms;
   no vendor lock-in; **no new database service unless the quality bar truly
   requires it**; fits the host's RAM envelope
   (`docs/implementation/28-operations.md:53, 64`).
4. **Token cost** — always-on push-layer cost plus per-use pull cost.

## 2. Current state (as-is)

### 2.1 Ownership split: the host owns the prompt, the BFF is a shell

| Concern | Owner | Evidence |
| --- | --- | --- |
| Host process, version | OpenCode 2.3.2 (official image), client range `^2.3.0` | `compose.yaml:277`; `packages/opencode/src/index.ts:185` |
| Sessions, messages, transcript persistence | OpenCode (`opencode-data` volume) | `compose.yaml:307` |
| Prompt assembly (system prompt, `AGENTS.md`, `instructions`, skills, tool schemas, history) | OpenCode — the app never builds a prompt | `docs/architecture/02-opencode-integration.md:158-187` (prompt payload is `text`, `files`, `agents`, `skills`, `metadata`, `delivery`, `resume` — no system-prompt field) |
| Tools, permissions, MCP servers | OpenCode (MCP config file-based; servers seeded by deploy) | `docs/architecture/02-opencode-integration.md:289-302, 377-384`; `deploy/remote/seed-config.sh:122-156` |
| Compaction (summarising) | OpenCode, seeded policy `auto=true buffer=35% keep.tokens=12000` | `deploy/remote/seed-config.sh:148-154`; `docs/implementation/27-compaction.md:16-24` |
| Auth, allowlisted proxy, event normalization, chat files, search proxy | the BFF (`apps/server`) | `docs/architecture/01-system.md:17-56`; `packages/opencode/src/live.ts:329-392` |

The BFF never shapes the prompt text: `POST /api/sessions/:id/prompt` →
`backend.prompt(id, { text, delivery, model, variant, agent })`
(`apps/server/src/prompt-route.ts:64-70`; `delivery` defaults to `"queue"`) →
the live adapter applies the model/variant/agent selection first, then calls
`client.session.prompt({ sessionID, text, id, delivery })`
(`packages/opencode/src/live.ts:121-133`). There is no prompt-shaping step in
this codebase. The `ChatBackend` port (`packages/opencode/src/index.ts:118-169`)
has no method for instructions, memory, or context assembly.

### 2.2 Memory-adjacent mechanisms that exist today

| Mechanism | What it gives | Evidence |
| --- | --- | --- |
| `AGENTS.md` | always-on project guidance, host-loaded, live edits | `docs/research/agent-memory.md:16`; `AGENTS.md` in this repo |
| `instructions` config | extra files/globs/URLs loaded after `AGENTS.md` | `docs/research/agent-memory.md:17` |
| Skills | on-demand procedural knowledge, advertised by id/name/description | `docs/research/agent-memory.md:18` |
| Session transcripts | every turn persisted in `opencode-data`, browsable via `message.list` | `compose.yaml:307`; `docs/architecture/02-opencode-integration.md:102` |
| Transcript search | chat titles via `session.list({ search })` — no message-level hits or snippets | `apps/server/src/search.ts:45-105`; `packages/opencode/src/live-search.ts:16-32`; `docs/architecture/02-opencode-integration.md:153-156` |
| Compaction | host summarises long sessions; summaries are persisted as message rows | `deploy/remote/seed-config.sh:148-154`; `docs/implementation/27-compaction.md` |
| `experimental.session.instructions.entry.*` | keyed `<context key="…">` blocks per session, updated at the next step boundary; `put` takes `{ sessionID, key, value }` with the value capped at 256 KiB (`MaxValueBytes`, `ValueTooLargeError`); the bare `session.instructions.*` surface is deprecated (removal slated for a next minor) | `docs/research/agent-memory.md:20`; host event `session.instructions.updated` at `docs/architecture/02-opencode-integration.md:248` |
| Local MCP servers | stdio servers inside the OpenCode container, seeded by deploy (`openchat`, `openchat-python`) | `deploy/remote/seed-config.sh:122-156`; `docs/architecture/02-opencode-integration.md:377-384` |

### 2.3 What does NOT exist

Each absence was verified, not assumed:

| Absence | Verification |
| --- | --- |
| A memory API in the host | "There is **no memory API**: nothing in the client or protocol stores facts about the owner." — `docs/research/agent-memory.md:23-25` |
| Any use of `experimental.session.instructions.*` in this repo | zero call sites in `packages/contracts`, `packages/opencode/src`, `apps/server/src` (grep, 2026-11-18); the observed host DB has `0` `instruction_entry` rows (§2.4), so the surface is unused even at host level |
| A facts/preferences store (L2) | no file, route, tool, or package touches `.memory/` or similar; `features/` contains only the README (`features/README.md:7-8` — "intentionally stays empty during the analysis phase") |
| Vector/embedding code (L3) | zero matches for `embedding|vector|pinecone|qdrant|chroma` in `packages/**/*.ts` (grep, 2026-11-18) |
| Memory in the spec, ADRs, or roadmap | no memory requirement anywhere in `docs/spec/**` (the only match is an observation of the *reference* product, `docs/spec/02-information-architecture.md:152`, OBS-019); ADRs stop at 0007 (`docs/decisions/`); issue #49's body still specifies the older review-gated design |

### 2.4 The quality of the L1 base facts (observed schema evidence)

Evidence source: a **read-only inspection of a real OpenCode 2.3.x SQLite
database** (2026-11-18). This is observed schema evidence from the host's
storage engine; it is **not** this project's deployment DB, and none of it is a
stable API — direct SQL is a host-side implementation detail (§6.5).

| Table | Observed columns | What it would give a memory layer |
| --- | --- | --- |
| `session_v2` | selected columns: `id, project_id, workspace_id, parent_id, fork_session_id, slug, directory, path, title, metadata, summary_additions, summary_deletions, summary_files, summary_diffs, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_idle, time_viewed, time_compacting, time_archived, time_suspended, resume_attempts, time_busy, idle_outcome` — plus `fork_boundary`, `version`, `share_url` and more | per-session provenance incl. **`agent` and `model`**, cost/usage, parent/fork links, workspace |
| `session_message` | `id, session_id, type, seq, time_created, time_updated, data (JSON)`; indexes `(session_id,seq)`, `(session_id,type,seq)`, `(session_id,time_created,id)`, `(time_created)` | a typed, ordered, timestamped turn stream — `type` distinguishes user/assistant/system/compaction/… rows |
| `session_part` | `message_id, session_id, ordinal, type, call_id, time_created, time_updated, data` | tool calls are recorded per part, typed, with stable `call_id` |
| `instruction_entry` | `session_id, key, value, removed, time_created, time_updated`, PK `(session_id, key)` | the real backing table for `experimental.session.instructions.entry.put` — keyed per session, soft-removable. Independent confirmation that the documented push surface exists |
| `event` | `id, aggregate_id, seq, created, type, data` + `event_sequence` | durable event log shape, matching the documented `durable { aggregateID, seq, version }` envelope (`docs/architecture/02-opencode-integration.md:209-211`) |

Observed scale in that DB, **at snapshot time** (the DB is live; counts
drift): **3,336 sessions, 188,489 messages** — 170,526
assistant / 5,967 synthetic / 5,272 idle / 4,725 user / 1,296 system / **468
compaction** / 197 model-switched; **0 `instruction_entry` rows; 0 `event`
rows.**

A caveat on the next paragraph: compile options are a property of the
**sqlite3 library that opened the file** (observed with the host's sqlite3
3.40.1), not of the database file itself. Observed there: `ENABLE_FTS3`,
`ENABLE_FTS3_PARENTHESIS`, `ENABLE_FTS3_TOKENIZER`, `ENABLE_FTS4`,
**`ENABLE_FTS5`**, `ENABLE_RTREE`, and `ENABLE_LOAD_EXTENSION`. **No vector
extension is compiled in** — a loadable vector extension is a possible
stage-2 shape to verify (§6.11), without adding a new service. **No FTS
virtual tables are currently defined** — any lexical index is ours to build,
and the runtime that will build ours (the BFF's `node:sqlite` or a sidecar)
must itself be verified for FTS5 before slice 7.

**Conclusion.** L1 is a high-quality corpus: typed, ordered, timestamped,
per-session, with agent/model/usage metadata and tool-call granularity. It is
rich enough to be the source for L2 extraction **and** for L3 retrieval — the
468 compaction rows in the observed DB are already per-session summaries, so
fact extraction has a natural starting point that is cheaper than raw
transcripts.

**Weaknesses, to be honest about:**

1. It is transcripts, not facts — extraction is required before anything is
   *recallable* as a preference or decision.
2. No cross-session index: per-session ordering only; nothing answers "what
   does the owner prefer across all sessions".
3. No FTS tables today and no vector extension compiled into the host's
   sqlite3 — L3 retrieval has to be built by us, over an export (§6.5). A
   loadable vector extension (the host library has `ENABLE_LOAD_EXTENSION`,
   §2.4) is the first stage-2 shape to verify; it adds no new service.
4. Our own BFF contract drops `agent`/`model` that the host stores:
   `packages/contracts/src/index.ts:30-40` (`SessionInfo` carries id, title,
   directory, created, updated, parentID, usage — no `agent`, no `model`) and
   `packages/contracts/src/transcript.ts:57-66` (`Message` likewise). If memory
   provenance wants per-fact agent/model context, the contract grows.

## 3. Fit assessment: the commissioning prompt vs this repo

The prompt that commissioned this work did not come from OpenChat. It reads as
if written for a **Google-based agent toolkit** — a framework lineage in which
the *application* owns the agent loop, assembles the prompt in its own context
builder, stores data in its own database, and can therefore invisibly prepend
retrieved memory to "the system prompt we build". OpenChat inverts that: the
host (OpenCode) owns the loop, the prompt, the tools, the permissions and the
transcripts; the app is a BFF shell with an allowlisted surface
(`docs/architecture/01-system.md:17-56`).

### 3.1 The four assumptions that do not hold

| External-prompt assumption | Reality in this repo | Evidence |
| --- | --- | --- |
| "OpenCode/OpenCore" host | The host is OpenCode 2.3.2, official image, pinned client major `^2.3.0`. "OpenCore" appears nowhere in this repo; no fork is used. | `compose.yaml:277`; `packages/opencode/src/index.ts:185, 190-195` |
| "our context builder" assembles the prompt | No context builder exists. The BFF forwards `text` verbatim; the host assembles the full prompt (system prompt, `AGENTS.md`, instructions, skills, tool schemas, history). | `apps/server/src/prompt-route.ts:39-65`; `packages/opencode/src/live.ts:121-133`; `docs/architecture/02-opencode-integration.md:158-187` |
| "our database" stores conversations and facts | No app database. Transcripts live in the host's `opencode-data` volume; the BFF's writable volumes are only `artifacts/` and `chats/` — the workspace is mounted **read-only** in the BFF. | `compose.yaml:85-91` (`workspace:/workspace:ro`), `:303-312`, `:440-451` |
| "invisible injection into the system prompt" | We do not build the system prompt, so we cannot inject into it. The documented mechanism is `experimental.session.instructions.entry.put`, producing a `<context key="…">` block announced at the **next step boundary** (not silently mid-turn), with a 256 KiB value cap (`MaxValueBytes`), observable as `session.instructions.updated`. | `docs/research/agent-memory.md:20, 139-152, 254-255`; `docs/architecture/02-opencode-integration.md:248`; confirmed by the observed `instruction_entry` table (§2.4) |

### 3.2 The three layers re-checked

| Layer (external concept) | Where it actually lives in OpenChat | Status |
| --- | --- | --- |
| **L1 — persistent transcripts** | OpenCode's own store: `session_v2` / `session_message` / `session_part` in the `opencode-data` volume; browsed via `message.list`; title-searched via `/api/search`; bounded by compaction | **Already solved by the host.** Rebuilding it would duplicate the host's store, drift from it, and violate the thin-adapter rule (`docs/architecture/02-opencode-integration.md:399`). Our job is *access* (§6.5), not storage |
| **L2 — facts/preferences store** | Nothing | **The actual gap.** No code, no doc, no tool (§2.3). This page designs it |
| **L3 — semantic/vector memory bank** | Nothing today — but per the owner correction it is a **staged target**, not a rejection: hybrid lexical retrieval first (BM25 over the L2 store, FTS5 over exported transcripts), embeddings/vectors later when justified (§6.11) | **Missing and staged.** The v1 non-goals (`docs/research/agent-memory.md:188-193`) and anti-patterns (`:54-60`) are v1-scoped decisions — evidence for what the *first* slice excludes, not a permanent verdict |

### 3.3 How the toolkit origin could have mis-led the design

1. **Layer duplication.** A toolkit that owns nothing must build L1 itself;
   porting that plan makes us build a second transcript database next to
   `opencode-data`. The host already persists, orders, types and timestamps
   every turn (§2.4) — duplicating it adds cost and a consistency problem, and
   would also re-ingest the agent's own output as a trusted source
   (`docs/research/agent-memory.md:58`).
2. **Invented injection point.** "Invisible injection into the system prompt"
   assumes an app-owned assembly step. Here the only push surface is
   per-session instruction entries: bounded, step-boundary-updated, capped,
   *visible* as an event. A design that assumes an invisible mid-prompt splice
   has no implementation path in this stack.
3. **Vector-by-default retrieval.** Google-style frameworks reach for
   embeddings first. For one owner's small fact store, lexical ranking is the
   research default (`docs/research/agent-memory.md:56` — "BM25 is enough for
   one owner's store"), and the observed host SQLite has no vector extension
   compiled in (§2.4). Embeddings remain stage 2, entered on evidence (§6.11).
4. **Pipeline-style writes.** In a toolkit, memory is written by app code in a
   pipeline stage. Here only three writers are possible — the agent (through
   gated MCP tools), the owner (through the UI), the BFF — and every write must
   pass host permissions and the clean-room rules, i.e. a validated write
   boundary, not a pipeline stage (§6.9).

## 4. Gap analysis against the three layers

### 4.1 L1 — covered by the host, with access gaps on our side

Solved: persistence, ordering, typing, timestamps, compaction summaries
(§2.4). Not solved by the host, and legitimately ours:

- **Access for retrieval.** The BFF never mounts `opencode-data`
  (`compose.yaml:85-91`; only the `opencode` service mounts it at
  `compose.yaml:307`, declared at `:449`), and the documented surface
  (`session.list` search) matches titles only
  (`docs/architecture/02-opencode-integration.md:153-156`). Message-level
  retrieval needs one of the routes in §6.5.
- **Contract loss.** Our normalization drops `agent`/`model` per session
  (§2.4, weakness 4) — a provenance gap for anything derived from L1.

### 4.2 L2 — the real gap

Nothing stores durable facts about the owner. Every session starts blind
(issue #49). This is the layer the recommended architecture builds: an atomic,
provenance-carrying, supersession-aware fact store with a bounded index
injected per session (§6).

### 4.3 L3 — missing today; staged, per the owner correction

- **Stage 1 (lexical, high-quality).** Hybrid retrieval over OpenCode's own
  data: BM25 over the L2 fact store (in the BFF's memory route, `mem_find` —
  no new dependency, consistent with the thin-client MCP design of §6.2) plus
  an optional FTS5 index over exported, redacted transcripts
  (route c in §6.5 — FTS5 is compiled into the host's sqlite3 library, §2.4,
  but has no tables today). This is deliverable with documented APIs and one
  small export job.
- **Stage 2 (embeddings/vectors), entered when justified.** Triggers to
  define, not to assume: measured recall misses of the lexical layer (logged by
  the tool), corpus growth beyond what BM25/FTS5 serves well, and an explicit
  owner decision. Until that decision, the literal v1 rule stands: **"No
  cloud memory, no embeddings service, no third-party memory vendor"**
  (`docs/research/agent-memory.md:190`). A self-hosted embedding model — or a
  loadable SQLite vector extension over our own export DB — is therefore a
  **deliberate re-scope**, and only the explicit owner decision this section
  and §6.11 demand can grant it.
- What stays true in both stages: memory is untrusted input (OWASP ASI06,
  `docs/research/agent-memory.md:51`), plain text over a platform
  (`:52`), bounded push layer (`:43`). Both stages are held to the §1.1 bar:
  stage 1 must already deliver currency (invalidation) and the breadth kinds;
  stage 2 adds recall, not staleness.

### 4.4 Blocking documentation gaps — real gates, not footnotes

The tracker and the docs do not agree on what is being built. Every one of
these blocks implementation, because the builder role reads *only*
`docs/spec/**`, `docs/architecture/**`, `docs/decisions/**`, `features/**`
(`AGENTS.md:14-18`) — today that reader gets either nothing or the wrong
design.

| # | Gap | Evidence | Closure step (exact) |
| --- | --- | --- | --- |
| G1 | No memory ADR | `docs/decisions/` ends at `0007-styling.md` | Write **ADR-0008** (`docs/decisions/0008-agent-memory.md`): decision = option B (§5) with L3 staging and the fallback-to-review-gated conditions |
| G2 | No memory section in the spec | `docs/spec/06-agents-tasks.md` has no memory content (read in full, 85 lines); the only "memory" match in `docs/spec/**` is an observation of the reference product (`docs/spec/02-information-architecture.md:152`, OBS-019) | Add a **"Memory" section** to `docs/spec/06-agents-tasks.md` (store, tools, injected index, `/memory` route, i18n) so the builder has a readable requirement |
| G3 | No roadmap entry | milestones live in the spec pages (`docs/spec/02-information-architecture.md:36`, `docs/spec/14-interactive-patterns.md:60-65`) and the tracker; no memory milestone exists anywhere in `docs/spec/**` (grep, 2026-11-18) | Add the **2.5 milestone line** for memory to the spec page that owns milestones, matching issue #49's milestone |
| G4 | `features/` has no slice | `features/README.md:7-8` — "intentionally stays empty during the analysis phase" | Expected until code starts; the slice directory is created **with the first implementation slice**, linking the spec section it implements (per `features/README.md:3-5`) |
| G5 | Issue #49 specifies the **older review-gated design** | issue #49 body: `memory.json`, `memory_propose`, `status: proposed\|approved\|archived`, "~1 500 tokens", BFF-only writer, approval gate; the owner comment on the same issue already records the pivot ("cross-session, self-managed incl. cleanup, file-based + MCP util, Code-Mode-capable, 2.5") | **Rewrite the issue #49 body** to the owner direction (agent-managed, `facts.jsonl`/`INDEX.md`/`audit.jsonl`, batch `mem_*` tools, ~400-token index, `/memory` as override not approval gate, L3 staged per §4.3), keeping the review-gated variant as the named fallback |

## 5. Design options

All options share non-negotiables from the research and the repo rules:
provenance on every entry, supersession over silent overwrite
(`docs/research/agent-memory.md:48`), TTL with confirmation-only renewal
(`:49`), search-before-write dedupe (`:50`), secret rejection at the write
boundary (`:60`), memory as untrusted input (`:51`), no third-party memory
service (`:190-193`), i18n for every user-visible string (`AGENTS.md:19-20`).
Each option is then scored on the §1.3 criteria against the §1.1 quality bar;
the comparison table makes those scores explicit.

### Option A — minimal BFF-owned single file (review-gated)

The variant issue #49's body still describes; kept as the fallback shape
(`docs/research/agent-memory.md:94-217`).

- **Storage.** One `memory.json` (versioned entries array, keyed, `0600`,
  atomic replace), under the workspace or a dedicated volume.
- **Write path.** BFF-only writer. Owner UI (`/memory`) writes `approved`;
  agent tool `memory_propose` writes `status: proposed` and can never approve
  (`docs/research/agent-memory.md:129-137`).
- **Injection/read.** On session create the BFF ranks approved entries by
  importance then recency and puts two entries (`memory/profile`,
  `memory/projects`, ~1 500 tokens total); retrieval tool `memory_search`
  returns full text plus provenance (`:139-160`).
- **Conflict resolution.** Key upsert; trim by rank on `ValueTooLargeError`,
  never fail the session; archive instead of delete; provenance survives
  session deletion (`:151-168`).
- **Pros.** Smallest surface; owner-controlled content; no agent write access
  to abuse; simple permission story.
- **Cons.** The agent never learns without owner approval work — memory
  starves in practice (the reason the owner moved away from it,
  `docs/research/agent-memory.md:221-227`); whole-file rewrite per write has
  the surveyed whole-store-rewrite scaling shape (`:31`); ~1 500 always-on
  tokens is ~4× the index variant; the approval UI is extra scope; conflicts
  with the owner direction on record.

### Option B — file-first agent-managed store + local MCP server + bounded injected index

The research note's "Recommended v1" (`docs/research/agent-memory.md:229-269`)
and the owner direction it records (`:219-227`).

- **Storage.** `/workspace/.memory/`: `facts.jsonl` (one atomic fact per line,
  append-only), `INDEX.md` (the push layer), `audit.jsonl` (every mutation).
- **Write path.** The agent writes through batch MCP tools (`mem_write`,
  `mem_update`, `mem_delete`, `mem_prune`) with search-before-write dedupe and
  secret/instruction-payload rejection; the owner overrides through `/memory`.
- **Injection/read.** `mem_index()` and the injected `memory.index` entry
  (`experimental.session.instructions.entry.put`, content of `INDEX.md`,
  ~300–400 tokens) form the push layer; `mem_find` / `mem_get` are the pull
  layer.
- **Conflict resolution.** Supersession (same topic → old fact kept and
  linked), TTL 90 days for `inferred`/`observed` and a year-or-never for
  `explicit`, confirmation-only renewal, prune dry-run with reasons, full
  audit.
- **Pros.** Matches the owner direction on record; token cost bounded and
  measurable; batch-first tools suit Code Mode (`:66-78`); plain text is
  diffable and backup-able with no new dependency; JSONL appends avoid the
  rewrite-per-write scaling problem; the agent actually maintains it.
- **Cons.** The agent can poison the store (mitigated, not eliminated:
  filters, TTL, audit, `/memory` override, permission rules — §6.10); more
  moving parts than A (one MCP package, BFF injection, UI); needs the
  G1–G5 closure first.

### Option C — full vector/RAG pipeline

The literal reading of the external prompt's L3, and the *stage-2* shape of
§4.3 — not the v1 shape.

- **Storage.** Embedded vectors + a vector index (SQLite extension or an
  external store), built by an ingestion pipeline over transcripts and facts.
- **Write path.** Background ingestion after sessions/compaction; an embedding
  service (cloud or self-hosted model).
- **Injection/read.** Top-k retrieved per request — which requires a
  per-request hook, i.e. a host plugin (`context`/`prompt` hook,
  `docs/research/agent-memory.md:21, 88`), a plugin package in the host image
  and an owner window (`:176-181`).
- **Conflict resolution.** Similarity dedupe; contradictions marked.
- **Pros.** Strongest recall at large corpus scale; per-request relevance.
- **Cons.** Depends on stage-2 justification that does not exist yet (no
  measured lexical misses); violates the current non-goals if it uses an
  embeddings service (`docs/research/agent-memory.md:190`); requires a host
  plugin the stack deliberately avoids in v1; embedding-everything is the
  documented anti-pattern for operational facts (`:54-56`); the target host is
  RAM-tight (3.9 GiB, `docs/implementation/28-operations.md:53`; the watchdog
  stops OpenCode below 900 MiB, `:64`).
- **Verdict.** Not rejected — **deferred with an entry trigger** (§6.11).

### Option D — memory-curator agent (the "very complete" variant)

Requested by the owner as a variant built around an **integrated intelligent
system** through which memory is accessed — not just passive MCP tools. It is
also the option that treats the §1.1 quality bar as *work*: curation, conflict
resolution and invalidation become an agent's job description.
Concretely: a dedicated **memory-curator agent** that owns extraction,
supersession, conflict resolution, pruning and summarisation; the chat agent
consults memory through MCP tools and the injected index; the owner keeps the
override UI and the audit.

- **Storage.** Same store as B (`/workspace/.memory/`): D is a different
  *writer/curator*, not a different shape.
- **Write path.** The curator is a host **subagent** (agent definition file —
  `mode: subagent`, own prompt, restricted tool list; started through the
  subagent tool, parent/child sessions visible in the UI,
  `docs/spec/06-agents-tasks.md:8-9`) and/or a **scheduled background
  session** (`experimental.schedule.create/list/...`,
  `docs/architecture/02-opencode-integration.md:121`; scheduled tasks run on
  the server without a browser, `docs/spec/06-agents-tasks.md:49-51`;
  running/finished jobs listable via `experimental.job.list`, `:122`).
  The schedule cannot pin the curator or its workspace (H2, resolved
  negatively) — the scheduled session's prompt must select the curator via
  the subagent tool or by agent choice inside that session.
  Curator duties: read compaction summaries and recent turns (L1 via §6.5
  routes), draft facts (`mem_write`, `trust: inferred|observed`), apply
  supersession (`mem_update` with reasons), run prune dry-runs, refresh
  `INDEX.md`.
- **Injection/read.** Unchanged from B: `memory.index` entry + `mem_find` /
  `mem_get`. The chat agent may *propose* explicit facts but does not curate.
- **Conflict resolution.** Intelligent, not just boundary validation: the
  curator resolves contradictions by reading both facts' provenance and
  writing a supersession with a reason; it owns the weekly prune proposal.
- **Documented-API parts.** Subagent definitions and the subagent tool
  (`docs/spec/06-agents-tasks.md:8-9`); `agent.list()` exposes mode
  primary/subagent (`docs/architecture/02-opencode-integration.md:111`);
  schedules/background jobs (`:121-122`); the `mem_*` MCP tools; the injected
  entry (`:248`).
- **HYPOTHESES to verify before adopting (each is a real gate; H2 is already
  resolved, negatively):**
  - **H1** per-agent tool/permission restriction: can a curator agent be
    limited to `mem_*` + read-only tools, while the chat agent gets read-only
    memory access? The representation side is already settled in the pinned
    client: `agent.list()`/`agent.get()` return `AgentInfo` with
    `permissions: PermissionRuleset`, and
    `PermissionRule = { action, resource, effect }` — so per-agent rules exist
    **in the agent definition**, they are not a global-only setting. Host
    permission rules are ordered `{action, resource, effect}` with
    last-match-wins (`docs/architecture/02-opencode-integration.md:298-302`).
    Open is **enforcement**: that a rule attached to the curator's definition
    actually restricts what that agent may call (and cannot be bypassed by
    the chat agent selecting it or by `execute`), which the spike in slice 1
    must demonstrate. Remains a verification gate (§8), not a design
    assumption.
  - **H2 — RESOLVED (negatively).** `ExperimentalScheduleCreateInput` in the
    pinned client has **no `agent` and no `location`** field: a schedule can
    start a session with a prompt and an end condition, but it cannot pin
    the curator agent or its workspace. The curator must therefore be
    selected via the subagent tool from inside the scheduled session, or by
    choosing the agent within it — not pinned by the schedule
    (`docs/architecture/02-opencode-integration.md:121`).
  - **H3** cost control: every curator run is a model call — compaction taught
    us that summarising on every turn is a cost problem
    (`docs/implementation/27-compaction.md:85-92`); the curator needs a run
    budget or a cadence cap.
  - **H4** concurrency/RAM: curator runs must be serial and idle-time, not
    alongside heavy sessions, on the 3.9 GiB host
    (`docs/implementation/28-operations.md:53, 64`).
- **Pros.** Highest memory quality (active curation, conflict resolution,
  summarisation by a reasoning process rather than only write-boundary
  validation); automatic capture finally has a natural home **without** a
  host-side plugin; reuses host machinery (subagents, schedules, jobs) — no
  new service or container; audit and owner override are preserved (curator
  writes carry `actor` in `audit.jsonl`); it is the credible path from
  B to full L3 (the curator is the component that would run stage-2
  ingestion).
- **Cons.** Most complex option; recurring token cost (H3); extraction
  happens between chats, not instantly; poisoning risk shifts from "any chat
  turn" to "curator runs" (same mitigations: filters, TTL, audit, override);
  three open hypotheses to retire before any of it is buildable (H2 is
  resolved, negatively — the schedule cannot pin the curator); the curator's
  writes must be permission-gated separately from the chat agent's (H1).

### Comparison and recommendation

| Criterion (§1.1, §1.3) | A single file | B file-first + MCP | C vector/RAG | D curator agent |
| --- | --- | --- | --- | --- |
| Quality-bar reach (depth/breadth/currency) | low — owner-gated facts starve | substrate: high with manual discipline; breadth limited to what the chat agent notices | high recall, but conflicts and staleness still need a curator | **highest** — extraction, conflict resolution and invalidation are the curator's job |
| Intelligence/depth | boundary validation only | boundary validation + chat-agent judgement | retrieval without curation | **curation by a dedicated reasoning process** |
| Extensibility (→ D, → L3 stages) | poor (single file, gate UI) | **good** — D and both L3 stages are additive on the same store | replace-once (its own pipeline) | **built for staging** — the curator runs the L3 stages |
| Operational simplicity | high | **high** — plain files + the seeded local-MCP pattern, no new service | low — new index, ingestion, host plugin | medium — host-native (subagent/schedule), no new container, but H1/H3/H4 |
| Token cost | ~1 500 always-on | **~400 always-on**, pull on demand | per-request k + ingestion runs | ~400 + capped curator runs |
| Documented-API-only | yes | **yes** | no (needs a host plugin) | mostly (H1/H3/H4 to retire; H2 resolved) |
| Owner override + audit | yes (approval gate) | **yes (override)** | implicit | **yes (override + actor in audit)** |
| Fits owner direction on record | no | **yes** | later | extension of B |

**Recommendation: B as the 2.5 substrate, D committed as the follow-on stage
that reaches the §1.1 quality bar, C gated as L3 stage 2.** B is the owner
direction on record (`docs/research/agent-memory.md:219-227`) and the cheapest
surface that satisfies token-efficiency and operational simplicity; D shares
B's entire store/tool/UI surface and is the only option whose *job
description* is the depth/breadth/currency bar, so under greenfield it is
scheduled, not left optional — its remaining H1/H3/H4 verification starts in
slice 1 (§8), with H2 already resolved (negatively: schedules cannot pin the
curator). A is relegated to a named emergency fallback (the store format already
supports `status: proposed`, `docs/research/agent-memory.md:267-269`); C is
entered only on the §6.11 trigger, and only in a shape that passes §1.3
(self-hosted, no new database service unless the quality bar truly requires
it).

## 6. Recommended architecture (option B, D-ready)

### 6.1 Store layout

`/workspace/.memory/` (volume decision D1, §7): the **directory `0700`** — a
directory needs the execute bit to be traversable by the `node` BFF, `0600`
would make it untraversable — and the **files `0600`** (`facts.jsonl`,
`INDEX.md`, `audit.jsonl`). All writes are atomic; no existing line is
mutated in place.

**Writer model — one process owns every file.** The store is written by the
BFF process only (`USER node`, `deploy/Dockerfile.bff:72`). The memory MCP
server does **not** write the volume directly: it writes **through the BFF**,
via an internal bearer-token route — the proven artifact-tool pattern
(`openchat_app_write` → `POST /internal/artifacts` with
`ARTIFACT_INTERNAL_TOKEN`, never in the public allowlist,
`docs/architecture/02-opencode-integration.md:345-352`), mirrored here as
`POST /internal/memory` with a `MEMORY_INTERNAL_TOKEN` seeded the same way.
This avoids the split-UID trap: the OpenCode container runs as root
(`compose.yaml:306-307`; `deploy/remote/seed-config.sh:17-19`) and would
spawn the MCP server as root, so root-written `0600` files would be
unreadable to the `node` BFF, and a root-owned fresh volume would not be
writable by `node` at all. With the BFF as the only writer, `0700`/`0600`
owned by `node` are coherent, `/memory` edits share the same code path, and
the OpenCode container gets at most a **read-only** visibility mount — and
only once the volume exists (see the bootstrap below).
(Rejected alternative: shared group + `2770`/`0660` + `group_add` — more
moving parts, no gain.)

**Fresh-volume bootstrap — and who mounts the volume first.** Docker seeds a
fresh named volume from the mount-point directory of the **first image that
mounts it** — content, ownership and mode come along — and not necessarily
from the BFF: `artifacts` is seeded by artifact-host, not by the BFF
(`deploy/Dockerfile.artifact-host:42-44`; the BFF side of the same trick is
`deploy/Dockerfile.bff:70-71`). Convention alone therefore does not make the
BFF the seeder — ordering does. So `memory-data` is mounted **read-write in
the BFF only** until the volume exists: the BFF image pre-creates the
mount-point directory, `chown node:node` **and `chmod 700`** it — the same
pre-create/chown pattern as `/workspace/chats` (`deploy/Dockerfile.bff:57-58`)
plus the explicit `chmod 700` that a directory needs to be traversable. Without that step a
fresh `memory-data` volume is root-owned and the BFF cannot create
`INDEX.md`; this is an explicit step in slices 2–3 (§8).

The optional **`:ro` visibility mount in OpenCode is a later step**, added
only after that bootstrap has run. `compose.yaml:274-326` declares no
`depends_on` from `opencode` to the BFF, and the OpenCode container runs as
root (`compose.yaml:306-307`) — if it mounted `memory-data` first, it would
seed a root-owned volume, exactly the state this bootstrap exists to avoid.
Whoever introduces the `:ro` mount must therefore make the order explicit
(`depends_on` on the BFF, or a dedicated init step that seeds and chowns the
volume before either container mounts it) rather than rely on startup
coincidence.

- **`facts.jsonl`** — one fact per line, append-only; a write never rewrites
  the store (the surveyed whole-store-rewrite scaling problem,
  `docs/research/agent-memory.md:31, 243`). Record shape
  (`:236-238`, extended for the §1.1 breadth bar): `id`,
  `kind (preference | profile | project | decision | episode | snippet)`,
  `text`, `topic`, `tags`,
  `source {sessionID, messageID, at}`, `trust (explicit | observed | inferred)`,
  `status (active | superseded | expired | deleted)`, `supersedes[]`,
  `createdAt`, `lastConfirmedAt`, `expiresAt`, `checksum`.
- **Kinds, not buckets:** one append-only store holds every kind — the earlier
  review-gated variant already had a `kind` field
  (`docs/research/agent-memory.md:108-109`), and it survives here. `episode`
  rows carry what happened and link their session; `snippet` rows carry
  code/solutions with a back-reference to the session and message; `decision`
  rows supersede their predecessors. The §1.1 breadth dimension without a
  second store.
- **`INDEX.md`** — the push layer: topic, ID ranges, one line per fact,
  hard-capped (research default ~400 tokens, `:274-275`).
- **`audit.jsonl`** — every write/update/delete/prune with actor, time and
  reason, so a bad prune can be explained and replayed (`:240-241`).

### 6.2 MCP tools — batch-first, Code Mode-shaped

A new local MCP server (sibling of `packages/artifact-tool`, seeded exactly
like `openchat`/`openchat-python` in `deploy/remote/seed-config.sh:122-156`;
MCP config is file-based, `docs/architecture/02-opencode-integration.md:377-384`).
It is a thin **client**: every `mem_*` call hits the BFF's
`POST /internal/memory` route with the shared token (§6.1), so the BFF stays
the only process that touches the store files.

MCP servers are exposed through Code Mode by default (`codemode: true`), so
the tools appear as `tools.<server>.<tool>(…)` inside `execute`
(`docs/research/agent-memory.md:66-71`). Array inputs and outputs let one
script search several queries, fetch details and write a batch with the
intermediate results never entering model context; MCP tool results are capped
(reported 2 000 lines / 51 200 bytes), so tools return compact JSON and their
own limits (`:76-78`).

Tool signatures (batch-only, no single-item variants, no read-the-whole-store
tool — `:244-253`):

```text
mem_index()                                              → INDEX.md content (capped)
mem_find({ queries[], tags?, since?, limit? })           → compact rows
mem_get({ ids[], fields? })                              → full records
mem_write({ entries[] })                                 → ids; dedupe + filters
mem_update({ updates[] })                                → status/supersession edits
mem_delete({ ids[], reason })                            → soft delete, never refused
mem_prune({ dryRun, maxAgeDays?, superseded?, maxBytes? })
mem_stats()                                              → counts, bytes, ages
```

### 6.3 Injection via `experimental.session.instructions.entry.put`

- On session creation the BFF reads `INDEX.md` from its own `memory-data`
  mount (D1) and puts one entry, key **`memory.index`** — the schema's key
  regex `^[a-z0-9][a-z0-9._-]*$` is slash-free (the server derives
  `api/<key>`), so a key like `memory/index` would be invalid. Content =
  `INDEX.md`, trimmed by rank, never mid-sentence, dropped entries logged
  (`docs/research/agent-memory.md:149-152, 254-255`).
- **Scope caveat.** `apps/server/src/routes.ts:213-228` covers only
  app-created sessions. Host-created sessions — subagent children (the
  contract carries `parentID`, `packages/contracts/src/index.ts:37`) and
  scheduled/background sessions (`docs/spec/06-agents-tasks.md:8-9`) — take
  other creation paths, so **BFF-at-create injection does not reach
  host-created child sessions**. Either listen for `session.created` on the
  existing event stream (`docs/architecture/02-opencode-integration.md:242`,
  block `:239-258`) and put the entry there, or accept the gap for v1 — a real
  choice, because option D relies on subagents that should inherit memory.
- The entry lands as a `<context key="…">` block announced at the **next step
  boundary** — not silently spliced into a running turn
  (`:20, 147-148`). When memory changes, the BFF re-puts the same key for
  still-active sessions; `session.instructions.updated`
  (`docs/architecture/02-opencode-integration.md:248`) confirms the host
  applied it and lets the BFF skip redundant puts.
- The cap is generous: `MaxValueBytes = 256 * 1024` per entry value — roughly
  160× a 400-token index. Rank-based trimming on `ValueTooLargeError` stays
  in as a defensive backstop, not the operative constraint (`:210-211`).
- **RISK R1 — RESOLVED (verified in the pinned client).**
  `@opencode/client@2.3.0` exposes
  `experimental.session.instructions.entry.put/list/remove`; `put` takes
  `{ sessionID, key, value: Json }` and raises `ValueTooLargeError` past
  `MaxValueBytes = 256 * 1024`; `session.instructions.updated` carries the
  rendered `text` and `delta`, so the BFF can confirm the host applied the
  entry. The bare `session.instructions.*` surface is marked deprecated
  (removal slated for a next minor) — code and docs must use the
  `experimental.` namespace. Smoke-test after every host upgrade, per
  `docs/architecture/02-opencode-integration.md:394-398`.

### 6.4 Retrieval and ranking (L3 stage 1 — lexical)

Ranking for `mem_find` (`docs/research/agent-memory.md:255-258`): topic/tag
match → BM25 keyword score → recency → hit count → trust. Superseded/expired/
deleted rows are excluded from search and reachable only by `mem_get`.

Transcript retrieval (the rest of L1) stays on the existing surfaces: chats
via `/api/search` (`apps/server/src/search.ts:45-105`), titles only
(`packages/opencode/src/live-search.ts:16-32`). Memory is not a second copy
of the chat log (`docs/research/agent-memory.md:159-160`).

### 6.5 L1 access for L3 — the accessibility caveat

The BFF does **not** mount `opencode-data`, and mounting it read-only into the
BFF would also expose `auth.json`/credentials in that volume — **rejected as
a route**. Realistic routes, all version-pinned:

- **Route a — ingestion sidecar/job.** A dedicated job with narrowly scoped
  read-only access to a **redacted export** (never the live volume). Runs
  where the curator (option D) or a schedule tells it to.
- **Route b — documented host APIs.**
  `experimental.session.export({ sessionID, sanitize? })` is one call
  returning the full session data — not paginated; only `message.list` is
  paginated. (The bare `session.export` in the pinned
  `@opencode/client@2.3.0` is the deprecated alias; code and docs use the
  `experimental.` namespace, as with the instruction-entry surface in §6.3.)
  `sanitize` is the redaction lever that feeds routes a and c. Stable,
  allowlistable through the BFF, no new mount — but an export job, not a live
  query path
  (`docs/architecture/02-opencode-integration.md:100-103, 110` — `:110` still
  lists the deprecated alias).
- **Route c — FTS5 index over exported transcripts.** Build an FTS5 index over
  the redacted export in a separate volume. FTS5 is compiled into the host's
  sqlite3 library (§2.4) but has no tables today, and the runtime that builds
  OUR index (the BFF's `node:sqlite` or a sidecar) must itself be verified for
  FTS5 before slice 7. This is the concrete stage-1
  L3: hybrid lexical retrieval — BM25 over `facts.jsonl` + FTS5 over
  transcripts — merged ranking.
- **Non-route (stated for the record).** Direct SQL against `opencode-data` is
  a host-side implementation detail, not a stable API: the §2.4 schema is
  evidence for planning (it shows what extraction can rely on — typed, ordered,
  timestamped rows, compaction rows as ready summaries), and any use must be
  version-pinned to the host image tag and re-verified per upgrade.

### 6.6 Lifecycle

- **Invalidation before staleness (§1.1 currency):** when the agent or the
  curator learns that a fact stopped being true, the fact is *retired with a
  reason* — both rows kept, linked (`supersedes[]`), never silently
  overwritten and never left to rot
  (`docs/research/agent-memory.md:48, 259-260`).
- **TTL:** `inferred`/`observed` facts expire after 90 days, `explicit` owner
  facts after a year or never; only explicit confirmation or reuse resets the
  clock — **retrieval alone must not renew** (stale memory is worse than none,
  `:49, 260-262`).
- **Prune:** weekly `mem_prune({dryRun:true})` returns ranked candidates with
  reasons; agent or owner applies (`:262-263`). Compaction does not delete
  memory — it lives outside session history (`:164`).

### 6.7 `/memory` owner override

A `/memory` page inside the app shell: browse (all statuses), edit, delete,
export JSON, and the audit view. The agent owns content; the owner keeps the
last word (`docs/research/agent-memory.md:264-265`). One i18n string set in
`en`/`de` (`AGENTS.md:19-20`). Memory text is plain text in the UI, never
rendered Markdown/HTML (`:199-200`). This is an *override*, not the approval
gate of option A — the fallback variant stays available on the same file
format (`status: proposed`) without migration (`:267-269`).

### 6.8 Test strategy (fake backend first)

Build against the fake backend before a real host
(`docs/spec/11-implementation-brief.md:22-25`, ADR-0004 pattern;
`packages/opencode/src/index.ts:172-177` exports the fakes):

- **Store unit tests:** atomic append, upsert, supersession links, TTL
  transitions, prune dry-run ranking, corrupt-line recovery, cap trimming;
  writer model — internal-route auth (`MEMORY_INTERNAL_TOKEN`) and
  fresh-volume bootstrap (mount-point ownership `node:node`, directory mode
  `0700`, file mode `0600`, the `deploy/Dockerfile.bff:57-58, 70-71`
  pattern). The bootstrap test must run against a **truly empty volume** — a
  reused or previously seeded volume already carries the ownership/mode it
  is meant to prove, so re-mounting an existing volume tests nothing.
- **Tool contract tests:** batch shapes, dedupe before write, secret/
  instruction-payload rejection, compact-JSON output limits.
- **Injection tests (fake):** new session gets the `memory.index` entry; a
  store change re-puts for active sessions; a superseded fact disappears;
  `ValueTooLargeError` trims instead of failing. Requires extending the
  `FakeBackend` with instruction-entry simulation (decision D7).
- **UI tests:** `/memory` browse/edit/delete/export/audit, keyboard reachable.
- **E2E (fake backend):** write a fact via the (fake) memory tool, start a new
  chat, assert the injected index contains it; supersede it, assert the old
  line is gone from the push layer.
- Gates before any commit: `pnpm run gates:fast` (`AGENTS.md:30-32`).

### 6.9 Clean-room write-boundary filters

The clean-room rule (`AGENTS.md:8-13`) applies to what the agent may *store*,
not only to what docs may contain. `mem_write` rejects:

- reference-product branding and names — the class of third-party brand names
  that `AGENTS.md:11-12` forbids in this repo;
- paths under `references/raw/` or content quoting third-party prompts/UI
  text;
- secrets and PII (`docs/research/agent-memory.md:60`);
- instruction-like payloads — memory is **data**, never directives; retrieved
  memory must not be treated as instructions (`:58`;
  `docs/architecture/02-opencode-integration.md:287`).

Rejected encounters are logged in `docs/clean-room/05-contamination-log.md`
(`AGENTS.md:12-13`).

### 6.10 Security and permissions

- **Memory is untrusted input** (OWASP ASI06): gate writes, keep provenance,
  expire unverified entries, never re-ingest the agent's own output as trusted,
  keep snapshots for rollback (`docs/research/agent-memory.md:51`).
- **Write tools are permission-gated** like every tool; the UI never
  auto-approves by default (`:201-203`;
  `docs/architecture/02-opencode-integration.md:302`).
- **The MCP write boundary — closed by mount, backed by rules.** Under the
  §6.1 writer model the OpenCode container gets at most a **read-only**
  visibility mount of the store, so the agent's ordinary file tools
  (`read`/`edit`/`write`) cannot mutate it: the kernel enforces the `:ro`
  mount, and writes exist only through the BFF's internal route, where every
  `mem_*` write validates. Host permission rules remain defense in depth:
  **deny `edit` on resources matching `.memory/**`, allow the memory MCP
  tools** (rules are ordered
  `{action, resource, effect}`, last match wins, and MCP tools carry their own
  action `<server>_<tool>`,
  `docs/architecture/02-opencode-integration.md:298-302`). Residual risk: if a
  writable mount is ever introduced, `shell`/`execute` bypasses `edit` rules —
  accepted and monitored (audit lines, checksums, weekly backups), with
  the store guaranteed secret-free so the blast radius is bounded.
- **No memory inside artifacts or sandboxed documents** (non-goal,
  `docs/research/agent-memory.md:192`); artifact content stays on the
  sandboxed origin (`AGENTS.md:40-42`).

### 6.11 The path to L3 (staged, per the owner correction)

| Stage | Retrieval | Prerequisites | Entry decision |
| --- | --- | --- | --- |
| **0 (ships with B)** | BM25 over `facts.jsonl` (`mem_find`) + injected ~400-token index | none beyond option B | recommended default (D2) |
| **1 — lexical hybrid over L1** | + FTS5 over a redacted transcript export in a separate volume (route c), merged ranking with L2 results | export job (route a/b), FTS5 tables, redaction filters | recommended as the *next* slice after `/memory`, same store, owner sign-off on the export scope (D9) |
| **2 — embeddings/vectors** | + semantic ranking when lexical measurably misses | measured misses (logged by `mem_stats`/`mem_find` telemetry), corpus growth, owner decision, RAM budget (`docs/implementation/28-operations.md:53, 64`); until that decision the literal v1 rule stands — "No cloud memory, no embeddings service, no third-party memory vendor" (`docs/research/agent-memory.md:190`) — a self-hosted embedding model, or a loadable SQLite vector extension, is a deliberate re-scope that the decision itself must name | **explicit owner decision only**; option C's plugin hook stays the alternative implementation shape |

Each stage advances a §1.1 dimension: stage 0 secures token-efficiency, stage 1
buys breadth (episodes, snippets and solved problems retrieved from L1),
stage 2 buys recall depth at scale. What does not change between stages: the
store, the audit, the `/memory` override, the write filters, the
untrusted-input stance, the bounded push layer. Stage changes touch retrieval
and ranking only — which is why L3 is a growth path here, not a redesign.

## 7. Open owner decisions (with recommended defaults)

| # | Decision | Options | Recommended default | Rationale |
| --- | --- | --- | --- | --- |
| D1 | Store location/volume and writer model | (a) inside the existing `workspace` volume with direct MCP writes; (b) separate `memory-data` volume, **read-write in the BFF only** (optional `:ro` visibility mount in the OpenCode container, added only after the fresh-volume bootstrap has run — §6.1), all writes through the BFF internal route (§6.1) | **(b) with the single-writer model** | The split UID is the trap: the BFF runs as `node` (`deploy/Dockerfile.bff:72`) while the OpenCode container runs as root (`compose.yaml:306-307`) and would spawn the MCP server as root — root-written `0600` files would be unreadable to `node`, and a root-owned fresh volume unwritable by it. A fresh volume is seeded by the **first image that mounts it** (`deploy/Dockerfile.artifact-host:42-44`), so the bootstrap (`chown node:node` + `chmod 700`) must run before OpenCode is allowed to mount it. (b) reuses the chat-files pattern (`compose.yaml:90-91, 445-448`): the BFF image pre-creates, `chown node:node`s and `chmod 700`s the mount point (`deploy/Dockerfile.bff:57-58, 70-71`), so one UID owns every file and `/memory` edits are synchronous; cost: compose entry + a sixth backup source in `backup.sh` (`docs/implementation/28-operations.md:76-92`). (a) rejected: direct MCP writes reintroduce the UID split or need shared-group gymnastics (`2770`/`0660` + `group_add`), and it widens the BFF's write surface |
| D2 | Token budget for the push layer | ~400 vs ~1 500 tokens | **400** | Research default (`docs/research/agent-memory.md:274-275`); the 1 500 figure belongs to the inject-the-facts variant (issue #49 body); measure real usage (`session.usage.updated`) before raising |
| D3 | Injection API | adopt vs re-verify | **Adopt — verified in the pinned client (R1 resolved)** | `experimental.session.instructions.entry.put/list/remove`, `put({ sessionID, key, value })`, `MaxValueBytes = 256 * 1024`, `ValueTooLargeError`, `session.instructions.updated` with rendered `text`/`delta` (§6.3); the bare `session.instructions.*` surface is deprecated — use the `experimental.` namespace; smoke-test per upgrade (`docs/architecture/02-opencode-integration.md:394-398`) |
| D4 | Prune trigger | automatic at session start vs agent-invoked | **Agent-invoked + weekly dry-run reminder** | Keeps session-start latency off the critical path and avoids surprise deletes (`docs/research/agent-memory.md:276-277`); the curator (option D) automates it later |
| D5 | Automatic capture timing | in 2.5 vs later | **Base 2.5 = B; commit the curator (D) as the next stage** | The §1.1 breadth/currency bar cannot be met by manual curation alone; the research defers plugin-based capture (`docs/research/agent-memory.md:176-181`) and a curator subagent/schedule does it host-natively, gated on H1/H3/H4 (H2 is resolved, negatively — schedules cannot pin the curator) |
| D6 | Clean-room filter set | minimal (secrets) vs full rejection list | **Full list at `mem_write`** (§6.9) | Branding, reference paths, prompt-like payloads, secrets — the store must not become a clean-room leak channel (`AGENTS.md:8-13`) |
| D7 | Fake backend scope | extend or not | **Extend `FakeBackend` with instruction entries** | E2E must assert the injected block without a live host (ADR-0004 pattern, §6.8) |
| D8 | Documentation closure | now vs with first code | **Slice 0, blocking** (G1–G5) | ADR-0008, spec section in `docs/spec/06-agents-tasks.md`, milestone line, issue #49 rewrite — before any implementation (§4.4) |
| D9 | L3 stage-1 shape | BM25-only vs +FTS5 export | **FTS5 export as the next slice after `/memory`** | Lexical hybrid is deliverable with documented APIs (routes a/b/c, §6.5); embeddings stay behind the stage-2 trigger (§6.11) |
| D10 | Contract growth | keep `SessionInfo`/`Message` minimal vs add `agent`/`model` | **Add with the provenance slice — greenfield makes it free** | The host stores both (§2.4); our contract drops them (`packages/contracts/src/index.ts:30-40`); nothing ships yet, so there is no migration cost (§1.2) |
| D11 | Quality-bar acceptance | implicit vs explicit | **Make §1.1 the acceptance checklist** | Every slice names the §1.1 dimension it advances (§8); "best-in-class chat assistant memory" stays measurable without naming any product |

## 8. Implementation sequence

No code in this document; the sequence exists so the tracker can carry it.
Slices are ordered by dependency; each ships its own tests (`AGENTS.md:26-32`).

| Slice | Content | Gate / notes |
| --- | --- | --- |
| **0 — alignment (blocking, docs + tracker only)** | Close G1–G5: ADR-0008; memory section in `docs/spec/06-agents-tasks.md`; milestone line in the spec; **rewrite issue #49 body** to the owner direction with the review-gated fallback named; keep `features/` empty until code starts | Everything else is blocked on this: the builder role reads spec/ADR/architecture only (`AGENTS.md:14-18`) and would otherwise build the wrong design |
| **1 — verification spike** | R1 resolved: `experimental.session.instructions.entry.put/list/remove` + `MaxValueBytes = 256 * 1024` in the pinned client; export shape probe (`experimental.session.export({ sanitize? })`, route b — the bare `session.export` is the deprecated alias); H1 per-agent permission enforcement (`AgentInfo.permissions: PermissionRuleset` exists in the pinned client; enforcement is open); H2 resolved negatively — `ExperimentalScheduleCreateInput` has no `agent`/`location`, so the curator is chosen via the subagent tool or inside the session, never pinned by the schedule | Throwaway spike or tests-only; results recorded in the issue; blocks slices 3 and 6 |
| **2 — store + tools** | `packages/memory-tool` (stdio MCP, §6.2), store layout + **single-writer model** (§6.1: `POST /internal/memory` + `MEMORY_INTERNAL_TOKEN`; fresh-volume `chown node:node` + `chmod 700` bootstrap per `deploy/Dockerfile.bff:57-58, 70-71`, volume mounted read-write in the BFF only until it exists), write filters (§6.9), audit; seed entry via `deploy/remote/seed-config.sh` (new sibling entry, same pattern as `openchat`); permission rules incl. the `.memory/**` file-tool deny (§6.10) | Fake-first contract tests; no UI yet |
| **3 — injection** | BFF reads `INDEX.md` from its `memory-data` mount, puts `memory.index` via `experimental.session.instructions.entry.put` on session create, plus `session.created` backfill for host-created child sessions (§6.3 scope caveat); re-puts on change; 256 KiB-cap trimming backstop; fake-backend extension (D7) | Depends on slice 1 |
| **4 — `/memory` UI** | Browse/edit/delete/export/audit, i18n `en`/`de`, plain-text rendering | Depends on D1 (BFF write access to the store) |
| **5 — lifecycle + ops** | TTL, supersession flows, weekly prune dry-run reminder; sixth backup source in `backup.sh`; ops notes in `docs/implementation/` | |
| **6 — curator agent (option D)** | Agent definition file, restricted tools (H1), curation runs with a cost cap (H3), serial/idle cadence (H4); the schedule cannot pin the curator (H2 resolved negatively) — the scheduled session's prompt selects it via the subagent tool; curator writes carry `actor` in the audit | **Committed stage toward the §1.1 bar** (D5); gated on H1/H3/H4, with H2 already resolved |
| **7 — L3 stage 1** | Redacted transcript export job (routes a/b) + FTS5 index in a separate volume (route c) + merged ranking | Gated on D9; export scope is an owner sign-off |
| **later — L3 stage 2** | Embeddings/vectors, self-hosted, behind the measured trigger | Explicit owner decision only (§6.11) |

---

**Sources for the mechanism survey behind the options:** all cited second-hand
through `docs/research/agent-memory.md:27-62`, which names the surveyed
open-source memory servers and records the observable behaviours of
best-in-class chat assistant memory. No product name or third-party text is
reproduced in this document, per the clean-room rule (`AGENTS.md:8-13`);
OWASP ASI06 is cited for the untrusted-input stance
(`docs/research/agent-memory.md:51`).
