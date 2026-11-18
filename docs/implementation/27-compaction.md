# 27 — Compaction policy

**Status:** 2026-11-18. Implements issue #53: the seeded host policy, the BFF
soft cap, the manual action and the visible state.

Compaction is not about fitting the largest possible prompt into a window. It
is about compacting early enough that every turn stays cheap and predictable.
The host does the summarising; the BFF only decides **when** to ask for it and
shows what happened.

## Seeded host policy

`deploy/remote/seed-config.sh` writes this block next to the MCP entries when
it creates `/opt/stacks/openchat/opencode-config/opencode.json`:

```json
"compaction": {
  "auto": true,
  "buffer": "35%",
  "keep": {
    "tokens": 12000
  }
}
```

| Key | Value | Meaning |
| --- | --- | --- |
| `compaction.auto` | `true` | The host compacts without a request. |
| `compaction.buffer` | `"35%"` | Room kept free **below** the window. |
| `compaction.keep.tokens` | `12000` | Recent tokens the summary must keep verbatim. |

An existing config file is never rewritten: the block is only in the file the
script creates, and the mode stays `0600`. No `agents.compaction.model` is
invented — the host keeps whatever summariser model its configuration names,
or its own default.

### Buffer math

A percentage buffer is subtracted from the model window:

```text
compaction threshold = limit.context × (100% − buffer)
```

With the chat chain capped at 200 000 tokens (see below), `35%` means the host
compacts at **130 000** tokens and keeps at least 12 000 recent tokens. With a
1 000 000-token window and the same buffer the threshold is 650 000; the BFF
cap is what actually pulls that down for chat.

## BFF soft cap

`CHAT_CONTEXT_SOFT_CAP` (default `200 000`, `0` turns it off) is the owner's
guard against a host that idles just below its own threshold. Before admitting
a prompt, the BFF reads the session's last reported usage and the run state in
**one** host call (`sessionContext`). If the context is at or over the cap and
the session is idle, it calls `session.compact` once, waits for
`session.compaction.ended`/`.failed` with a 20-second bound, and then sends the
prompt.

The gate deliberately fails open:

- an unreadable session or no reported usage means no compaction, and the
  prompt still sends;
- a streaming session is never compacted, not even with a queued prompt;
- a failed or timed-out compaction adds a notice and the prompt continues;
- the usage level of the last attempt is remembered, so the same context is
  not compacted twice; only a higher reported usage permits another attempt.

The prompt response carries machine keys (`contextCompacted`,
`contextCompactionFailed`) in `notices`; the client renders them through i18n.
No user-visible text is produced by the server.

### Why it costs tokens

Compaction is a model call: the summariser reads the conversation and writes a
summary. It is not free, and a session that compacts at every turn pays for a
summary at every turn. That is why the soft cap exists in addition to the
host's own policy: it bounds the context **without** summarising on every
message, and the dedupe rule prevents a compaction loop when the host keeps
reporting the same usage.

## Background compaction stays off

`experimental.background_compaction` is **not** enabled by the seed script. An
opt-in run summarises while the owner is idle, which costs tokens even when no
prompt follows. The host can enable it in its own config; the app does not
turn it on.

## Named alternative: `limit.context`

OpenCode lets a provider/model entry override its context window. A named
per-model cap for the chat chain (for example `200 000`) makes the host itself
compact earlier and needs no BFF code. The downside is that it is provider
configuration, not per session or per chat: every session of that model pays
the smaller window, including work that would benefit from the full one, and
the cap is invisible in the app unless the documented config path is read. The
BFF soft cap is the deployment-wide guard; the provider override remains the
host-side alternative.

## Manual action and state

- `POST /api/sessions/:id/compact` goes through the authenticated BFF and calls
  the host's `session.compact`. A streaming session answers `409 conflict`; an
  unknown session `404`; a host that cannot answer `400 unavailable`.
- The chat header's action menu holds **Compact now**, disabled while a run is
  active.
- The transcript renders `session.compaction.started`, `.ended` and `.failed`
  as one collapsed section per attempt. `ended` shows the host's summary text;
  `failed` shows the host's reason and a retry button.
- The header shows `used / limit (percent)` from the selected model's
  `limit.context` and the last reported usage. Usage counts input plus cache
  read/write. Missing usage or a missing window is a neutral dash, never a
  fabricated number. Its tooltip explains the `100% − buffer` threshold.
- Usage is restored from the last assistant message on reload; compaction
  notices are event-scoped and are not replayed from host history.

## Events

| Event | UI effect |
| --- | --- |
| `session.usage.updated` | Updates the header fill. |
| `session.compaction.started` | Opens a collapsed section. |
| `session.compaction.ended` | Closes it with the summary. |
| `session.compaction.failed` | Closes it with the reason and retry. |
| `session.execution.failed` | Unchanged: the failed answer stays visible. |

`session.compaction.delta`, `session.usage.recorded` and
`session.retry.scheduled` pass through the stream unchanged; the transcript
does not need them for this slice.

## Tests

- Seed dry run pins `auto=true buffer=35% keep.tokens=12000`; the written file
  is parsed and checked, and no compaction model is invented.
- Server: below the cap no compaction, at the cap one compaction plus notice
  and the prompt proceeds, streaming skips, failure warns but proceeds, a
  repeated usage level does not compact again, `0` disables the gate.
- Route: authentication, started/ended events, `409` while streaming, `404`
  unknown session, host failure mapping.
- Web: event fold, fill arithmetic (including unknown), transcript sections,
  retry and the disabled menu item.
- E2E (fake backend): crossing the cap, Compact now, failure plus retry.
