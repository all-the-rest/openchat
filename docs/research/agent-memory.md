# Agent memory — how the agent learns the owner over time

Research note, 2026-11-18. Question: how can the agent get to know the owner
better across sessions and keep that knowledge, without turning every chat into
a prompt dump and without shipping data to a third party?

This note records the mechanisms that exist in OpenCode 2.3.x, what we already
run, and a v1 design that can be built on documented APIs only. It is research,
not a spec: the spec question is answered in `docs/spec/06-agents-tasks.md` and
would need an owner decision before implementation.

## What exists today

| Mechanism | What it gives us | Evidence |
| --- | --- | --- |
| `AGENTS.md` | Always-on project guidance, loaded from the global config and from the workspace upwards; edits are picked up live | OpenCode docs "Instructions"; `AGENTS.md` in this repo |
| `instructions` config | Extra files, globs or URLs loaded after `AGENTS.md`, with live updates | `@opencode/schema/dist/config.d.ts:89` |
| Skills | On-demand procedural knowledge; only ID, name and description are advertised until the model loads one | OpenCode docs "Skills"; `.opencode/skills/**` |
| Session transcripts | Every turn is persisted in the `opencode-data` volume and searchable | `compose.yaml:262`; `apps/server/src/search.ts:46` |
| `session.instructions.entry.*` | Keyed instruction entries per session, rendered as `<context key="…">` blocks, updated at the next step boundary, with a `ValueTooLargeError` cap | `client/dist/effect/generated/client.d.ts:298-303` |
| Server plugins | `context`, `prompt` and `compaction` hooks can edit the outgoing request, plus durable `ctx.storage`, custom tools and an event stream | OpenCode docs "Building plugins → Server" |

There is **no memory API**: nothing in the client or protocol stores facts about
the owner. Memory is assembled from instructions plus conversation history, and
anything durable has to be built by us.

## Landscape of existing solutions (surveyed 2026-11-18)

| Solution | Storage | Retrieval | Cleanup | Token cost | Fit |
| --- | --- | --- | --- | --- | --- |
| `@modelcontextprotocol/server-memory` | one JSONL knowledge graph (entities, relations) | substring search, open by name, read graph | 6 CRUD tools, no TTL; manual prune | whole graph rewritten per write; 100k entities ≈ 24 MB / ~0.4 s | high for batch shape, low for cleanup |
| basic-memory | Markdown + front-matter, DB as index | hybrid FTS + semantic, wiki links | none automatic | slices, not whole store | medium (AGPL, heavy) |
| mcp-memory-service | SQLite + vectors, knowledge graph | semantic + BM25 + ranked mode | consolidation, controlled forgetting, contradictions marked | token-budgeted profile | medium (service to run) |
| Mem0 / OpenMemory | hosted or local vectors + facts | fused semantic/keyword/entity | explicit update/delete | fact-level, claims >90 % savings | low (hosted) / medium |
| claude-mem | SQLite FTS + optional vectors | 3-step `search → timeline → get_observations` | observer agent compresses sessions | index rows ~50–100 tokens, detail ~500–1000 | high as design reference |
| okf-agent-memory | git Markdown bundle | BM25 in-process | scorecards, `stale_after`, trust tiers | push layer capped at 400 tokens | high as design reference |
| Letta / MemGPT | git-backed memory files | pinned `system/` + on-demand reads | background "dreaming" | explicit pinned/on-demand split | medium as concept |
| Graphiti / Zep | temporal graph + episodes | hybrid + graph distance | facts invalidated, never silently overwritten | retrieved edges only | low as product, high as concept |
| ChatGPT / Claude / Cursor / Copilot memory | product stores | ranked injection, citations | vote/expiry, review UI, restore | curated | patterns only |

### Takeaways adopted for our v1

1. **Two layers**: a tiny push layer (index, a few hundred tokens) and a pull layer fetched on demand — Letta (`system/` vs files), OKF (400-token cap), claude-mem (compact index).
2. **Batch-first tools**: array inputs and outputs, so one Code Mode script does many queries or writes — the reference server and claude-mem both do this.
3. **Atomic facts with provenance**, not transcripts — Mem0's core lesson; raw transcripts stay in OpenCode's own storage and search.
4. **Compact index rows + fetch by ID** — claude-mem's `search → get_observations` is the cheapest shape.
5. **Hard caps and deletes that are never refused**, so an oversized store can always shrink — reference server's `MEMORY_MAX_*`.
6. **Supersession instead of silent overwrite** — Graphiti's validity windows, mcp-memory-service's marked contradictions; keep the old fact, link it.
7. **TTL with confirmation-only renewal** — Copilot's 90-day expiry that retrieval does not reset; stale memory is worse than none.
8. **Search before write, dedupe at the boundary** — OKF's rule; prevents ten near-identical facts.
9. **Memory is untrusted input** — OWASP ASI06 (memory and context poisoning): gate writes, keep provenance, expiring unverified entries, no re-ingestion of the agent's own output, snapshots for rollback.
10. **Plain text + small utilities over a platform** — diffable, backup-able, no AGPL/Elastic/hosted dependency.

### Anti-patterns

- Embedding everything by default (semantic search misses operational facts; BM25 is enough for one owner's store).
- Injecting the whole store ("prompt monolith") — attention drift and cost on every message.
- Silent writes without provenance; treating retrieved memory as instructions; re-ingesting the agent's own output as trusted.
- Unbounded growth; a store that cannot be shrunk.
- Secrets/PII in memory (reject at the write boundary).

Sources: [server-memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory), [basic-memory](https://docs.basicmemory.com/reference/technical-information), [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service), [Mem0](https://docs.mem0.ai/core-concepts/memory-types), [claude-mem](https://github.com/thedotmack/claude-mem), [OKF](https://github.com/okf-memory/okf-agent-memory), [Letta](https://docs.letta.com/agent-sdk/memory/), [Graphiti](https://github.com/getzep/graphiti), [Copilot memory](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory), [OWASP ASI06](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/).



## Code Mode and MCP

MCP servers are exposed **through Code Mode by default**: the `codemode` field
on a server defaults to `true`, and its tools appear as
`tools.<server>.<tool>(…)` inside the `execute` tool rather than as separate
native tools. Setting `codemode: false` lists them directly.

That matters for memory: a memory MCP server can expose `search({ queries: [] })`
and `write({ entries: [] })` so one script answers several questions or stores
several facts in a single step, and the intermediate results never enter the
model context. MCP tool results are also capped (reported as 2 000 lines /
51 200 bytes with the full output saved to a file), so a memory tool should
return compact JSON and its own limits.

## Options

| Option | Injection | Write path | Review | Risk |
| --- | --- | --- | --- | --- |
| A. Grow `AGENTS.md` | Automatic, always | Agent or owner edits the file | Git diff | Owner-owned file; every turn pays for every line; instructions are privileged and invisible to clients |
| B. Generated `instructions` file | Automatic, always | A tool or job rewrites the file | Read the file | Same cost per turn; a bad write is always-on; needs a writable file the agent should not edit freely |
| C. Per-session instruction entries | Automatic per session, bounded | BFF or plugin | UI can show and remove | Experimental API; per-session, so a new session needs a fresh put; size cap |
| D. MCP memory server (tools only) | On demand (`memory_search`) | Agent | Implicit | The agent must remember to recall; nothing is injected |
| E. Plugin hooks | Automatic, per request, can also summarize on `compaction` | Plugin storage or files | Depends on the plugin | A plugin package must live in the host image and resolve `@opencode/plugin`; more moving parts |

The useful combination is **C + D**: a small, reviewed memory block injected
into every session, plus a tool for detail on demand. A is for rules, not for
facts about a person; E is the natural home for automatic capture later.

## Review-gated variant (fallback)

A store owned by the BFF, written only by the owner or through an explicit
proposal. Kept here because self-management could poison the store in practice;
the same file format supports it with `status: proposed` and no migration.

### Data model

```jsonc
{
  "version": 1,
  "entries": [
    {
      "key": "preference.language",
      "kind": "preference",          // profile | preference | project | decision
      "text": "Prefers German UI, English docs and commit messages.",
      "source": { "sessionID": "ses_…", "messageID": "msg_…" },
      "importance": 3,               // 1..5, owner-editable
      "status": "approved",          // proposed | approved | archived
      "created": "2026-11-18T…",
      "updated": "2026-11-18T…"
    }
  ]
}
```

- Stored once in the workspace (`/workspace/.memory/memory.json`, atomic
  replace, `0600`), so it survives redeploys with the rest of the workspace and
  never leaves the host.
- `key` is a stable slug; a second write with the same key updates rather than
  duplicates. `source` keeps provenance so a memory can be traced back to the
  turn that produced it.
- `status: proposed` exists so the agent can suggest a memory without it
  entering the prompt. Only `approved` entries are injected.

### Write paths

1. **Owner UI** (`/memory`): list, filter by kind, edit text and importance,
   delete, export JSON. Editing sets `status: approved`.
2. **Agent tool** `memory_propose` (MCP or plugin tool): `{ key, kind, text,
   importance }` → `proposed`. It never writes `approved`. The UI shows a badge
   with the count.
3. No automatic write in v1. A wrong "fact" that is silently learned is worse
   than no memory.

### Injection

- On session creation the BFF assembles the approved entries, ranks them by
  importance then recency, and writes at most ~1 500 tokens into two entries:
  `memory/profile` (profile + preferences) and `memory/projects` (projects +
  decisions).
- When memory changes, the BFF updates the entries of sessions that are still
  active (`session.instructions.entry.put` again, same keys); the change is
  announced at the next step boundary, so no prompt is injected and no turn is
  queued.
- The entry text is a plain Markdown list with the key and one sentence each:
  `- preference.language — Prefers German UI, English docs and commit messages.`
- Respect the API cap: trim by rank, never truncate mid-sentence, and log which
  entries were dropped.

### Retrieval

- `memory_search` (tool) queries the store by substring and kind and returns
  full text plus provenance. Injected entries carry only the summary, so the
  detail is one tool call away.
- Transcripts stay searchable through the existing `/api/search`; memory is not
  a second copy of the chat log.

### Lifecycle

- **Compaction** does not delete memory: it lives outside the session history.
- **Archive** instead of delete for entries that stopped being true, so the
  provenance and the history stay traceable; the UI defaults to approved only.
- **Session deletion** does not delete memories derived from it; the provenance
  link becomes a dead reference and is shown as such.

### UI

A `/memory` page inside the app shell: approved list, proposals inbox, add and
edit, delete with confirmation, export. One i18n string set in `en`/`de`. No
new dependency.

## Later (not v1)

- **Automatic capture**: a server plugin with a `compaction` hook can propose
  memories after a long session, or a `context` hook can rank entries per
  request instead of per session. This needs a plugin package in the host image
  (see risks) and an owner window to install it.
- **Per-request ranking**: choose entries by relevance to the current prompt
  instead of a fixed top-N.
- **Structured profile**: a form for name, timezone, languages, tone and
  recurring projects, instead of free text.
- **Memory-aware suggestions**: the landing chips use approved preferences.

## Non-goals

- No cloud memory, no embeddings service, no third-party memory vendor.
- No silent learning from transcripts.
- No memory inside artifacts or sandboxed documents.
- No cross-user memory: the deployment is single-owner.

## Security and privacy

- The store is local to the workspace volume; the BFF is the only writer, with
  the same path rules as chat files (single directory, no traversal).
- Memory text is owner-approved, but it still enters the system context: it
  must be plain text, never HTML, and it is not rendered as Markdown by the UI.
- `memory_propose` is a write tool: it is permission-gated like every other
  tool, and it cannot approve its own proposals.
- Export is explicit; there is no automatic sync.

## Test plan

- Store: atomic write, key upsert, status transitions, cap trimming by rank,
  corrupt file recovery (keep the last good copy).
- Injection: a new session gets both entries; a change updates an active
  session; an archived entry disappears; `ValueTooLargeError` is handled by
  trimming, not by failing the session.
- Tool: propose validates kind/key/text length and never returns another
  entry's text.
- UI: approve, edit, delete, export; proposals badge; keyboard reachable.
- E2E (fake backend): propose a memory, approve it in `/memory`, start a new
  chat, assert the injected block contains the approved sentence and the
  proposal is gone from the prompt.

## Owner direction (2026-11-18)

The owner narrowed the design: memory is **self-managed by the agent**,
including cleanup, and it must be **token-efficient**: a file as the source of
truth plus a small query utility (an MCP server) that is callable from Code
Mode, so one script can run several searches or write several entries. It is
cross-session and ships in 2.5. The sections above describe the mechanism
survey; "Recommended v1" below reflects the owner direction, with the review
step reduced to an owner override in the UI instead of an approval gate.

## Recommended v1 — "agent-managed memory"

A file-first store under `/workspace/.memory/`, written and pruned by the agent
through a small MCP server, plus a bounded index injected per session.

- **Store** (the research-backed shape):
  - `facts.jsonl` — one atomic fact per line: `id`, `text`, `topic`, `tags`,
    `source {sessionID, messageID, at}`, `trust` (`explicit | observed |
    inferred`), `status` (`active | superseded | expired | deleted`),
    `supersedes[]`, `createdAt`, `lastConfirmedAt`, `expiresAt`, `checksum`.
  - `INDEX.md` — the push layer: topic, ID ranges, one line each, capped.
  - `audit.jsonl` — every write/update/delete/prune with actor, time and reason,
    so a bad prune can be explained and replayed.
  - JSONL instead of one rewritten document: a write never rewrites the whole
    store (the reference server's main scaling problem).
- **Tools** (MCP, array inputs and outputs, compact JSON):
  `mem_index()`, `mem_find({ queries[], tags?, since?, limit? })` → compact rows,
  `mem_get({ ids[], fields? })` → full records only for chosen IDs,
  `mem_write({ entries[] })` with search-before-write dedupe and secret /
  instruction-like payload rejection, `mem_update({ updates[] })`,
  `mem_delete({ ids[], reason })` (soft delete, never refused),
  `mem_prune({ dryRun, maxAgeDays?, superseded?, maxBytes? })`,
  `mem_stats()`.
  No single-item variants and no "read the whole store" tool, so one Code Mode
  script can search several queries, filter, fetch details and write a batch.
- **Injection**: `memory/index` via `session.instructions.entry.put`, content of
  `INDEX.md` (~300–400 tokens) refreshed at step boundaries when memory changes.
- **Ranking**: topic/tag match, then BM25 keyword score, then recency, then hit
  count, then trust. Superseded/expired/deleted are excluded from search and
  reachable only by `mem_get`.
- **Lifecycle**: a new fact on the same topic supersedes the old one (both kept,
  linked); `inferred`/`observed` facts expire after 90 days, `explicit` owner
  facts after a year or never; only explicit confirmation or reuse resets the
  clock, never mere retrieval. Weekly `mem_prune({dryRun:true})` returns ranked
  candidates with reasons; the owner or the agent applies it.
- **Owner override**: `/memory` page to browse, edit, delete, export and see the
  audit — the agent owns the content, the owner keeps the last word.

The earlier "approved memory" variant stays as a fallback if self-management
turns out to poison the store in practice; the store format supports it
(`status: proposed`) without a migration.

## Open owner decisions

1. Is the workspace volume the right home, or a separate `memory-data` volume?
2. How much context is worth paying for on every session (a ~400-token index is
   the research default; measure before raising it)?
3. Does `mem_prune` run automatically at session start, or only when the agent
   calls it?

## Recommendation

Ship v1 as **file-first agent-managed memory + MCP tool + `/memory` + bounded
per-session index**. It uses only documented APIs, adds no host-side plugin,
and keeps every fact visible and editable for the owner. Automatic
summarisation of every session (a plugin `compaction` hook) remains a later
slice on the same store.

