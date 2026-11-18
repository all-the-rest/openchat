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

- **Store**: an `index.json` plus per-topic Markdown files with front-matter
  (key, kind, importance, provenance, timestamps, status). Atomic writes,
  `0600`, single directory with the same path rules as chat files.
- **Tools** (batch-friendly, compact JSON): `search({ queries[], kind?, limit? })`,
  `read({ keys[] })`, `write({ entries[] })` (upsert by key), `update({ keys,
  patch })`, `delete({ keys[] })`, `maintenance({ dryRun })` for duplicates,
  stale entries and oversized topics, `stats()` for the agent's own budgeting.
- **Injection**: `memory/index` via `session.instructions.entry.put`, top-N by
  importance then recency, ~1 500 tokens; refreshed at step boundaries.
- **Owner override**: `/memory` page to browse, edit, delete, export — the agent
  owns the content, the owner keeps the last word.

The earlier "approved memory" variant stays as a fallback if self-management
turns out to poison the store in practice; the store format supports it
(`status: proposed`) without a migration.

## Open owner decisions

1. Is the workspace volume the right home, or a separate `memory-data` volume?
2. How much context is worth paying for on every session (1 500 tokens is a
   starting point, not a measurement)?
3. Does `maintenance` run automatically at session start, or only when the agent
   calls it?

## Recommendation

Ship v1 as **file-first agent-managed memory + MCP tool + `/memory` + bounded
per-session index**. It uses only documented APIs, adds no host-side plugin,
and keeps every fact visible and editable for the owner. Automatic
summarisation of every session (a plugin `compaction` hook) remains a later
slice on the same store.

