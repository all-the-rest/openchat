# 33 — Fallback policy: one retry, no rewrite

**Status:** 2026-11-18. Core decisions for issue #54. The prompt/SSE wiring is a
separate slice; this page documents the rules every surface must follow.

## Owner decision: no revert

The host has no message delete (only `session.revert.stage|commit|clear`, which
is a staged, file-rolling, user-visible primitive). The fallback therefore
**never rewrites history**: a failed turn stays visible, and the retry appends a
new attempt on the next model. The UI shows one translated notice, not a silent
rewrite.

## Policy, per surface

One `TurnPolicy`:

```
{ surface: "chat" | "code", chain: ModelRef[], paidDailyCap: number, contextSoftCap: number }
```

- **chat** carries an ordered chain (≤ 5 entries, duplicates rejected by
  `provider + model + variant`), the paid daily cap and the context soft cap.
- **code** carries an empty chain and zero caps, so the Code host's model choice
  is untouched by this machinery.

`contextSoftCap` is enforced by the compaction slice (#53), not here; the
fallback engine only reads it as part of the same policy object.

## What may be retried

| Reason | Retry |
| --- | --- |
| `rate_limit` | yes |
| `provider_error` (5xx) | yes |
| `timeout` | yes |
| `context_overflow` | yes |
| `auth` | no — needs owner action |
| `unknown` | no — never guessed |

Classification reads a stable code first, then only the first 200 characters of
the message as a keyword fallback. Provider prose is never interpreted. The
host's `retryable` flag is advisory: it cannot rescue `auth`/unknown and cannot
erase a stable code.

## When a retry happens

All must hold:

1. surface is `chat`;
2. the failed attempt was the **first** (`attempts === 1`, so at most one retry
   per turn);
3. **no assistant text** was emitted — whitespace counts as output;
4. the reason is retryable;
5. the chain has a next, untried entry;
6. that entry is free (`isFree === true`) or the paid budget has room
   (`paidDailyCap === 0` means off, otherwise `paidSpent < paidDailyCap`).

`isFree` is explicit on the entry because the core has no price data: absent
means paid. Free entries bypass an exhausted cap; a missing flag is never read
as free.

## Usage ledger

`UsageLedger` keeps per-day spend under an injected directory:

- one `YYYY-MM-DD.jsonl` per **local** day, day boundary from an injected clock;
- rows `{ at, providerID, modelID, turns, costMicros }`, appended under a small
  in-process lock with `O_APPEND | O_CREAT | O_NOFOLLOW`, mode `0600`;
- a 4 MiB cap **refuses** the row with `usage_ledger_full` instead of rotating
  away the day's history;
- a corrupt line is skipped and counted (`skippedToday()`), never thrown.

## Wiring points (implemented in #35)

- prompt admission resolves the policy (chat from settings, Code as the empty
  policy) and picks the first entry with `nextModel(policy, [])`;
- the event loop tracks `attempts`, accumulated `session.text.delta` text and
  `tried`; on `session.execution.failed` it calls `shouldFallback`;
- on `true`: switch to `next`, re-prompt the same text once, append to `tried`;
- on completion: `ledger.record(...)` and emit `TurnOutcome`
  (`requested`, `answered`, `fellBack`, `reason`, `attempts`);
- the UI renders one i18n notice; the fake backend gets a scripted failure so
  the flow is provable without a provider.

The implemented wiring is documented in
[`35-fallback-wiring.md`](./35-fallback-wiring.md).

## Tests

`packages/contracts/test/turn-policy.test.ts` (chain bounds, duplicates,
surface), `apps/server/test/fallback-policy.test.ts` (classification matrix,
no fallback after text, one retry only, caps, free bypass, code surface),
`apps/server/test/usage-ledger.test.ts` (append, day rollover, corrupt lines,
`0600`, injected directory, cap refusal).
