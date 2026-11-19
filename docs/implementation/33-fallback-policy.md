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
{ surface: "chat", chain: ModelRef[], paidDailyTurns: number, contextSoftCap: number }
```

- **chat** carries an ordered chain (≤ 5 entries, duplicates rejected by
  `provider + model + variant`), the paid daily turn cap and the context soft
  cap. A `ModelRef` may also carry `isFree` and `contextLimit`.
- **Code** never gets a policy. It is a separate host and never enters the
  prompt route, so `TurnSurface` has no `"code"` member and a code policy cannot
  be built at all; a wiring test asserts Code never touches the engine or the
  ledger.

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

1. the policy is a chat policy — the only surface that builds one;
2. the failed attempt was the **first** (`attempts === 1`, so at most one retry
   per turn);
3. **no assistant text** was emitted — whitespace counts as output;
4. the reason is retryable;
5. the chain has a next, untried entry;
6. that entry is free (`isFree === true`) or the paid-turn budget has room
   (`paidDailyTurns === 0` means off, otherwise `paidTurnsToday() < paidDailyTurns`);
7. for `context_overflow`, when both the failing and the next entry carry a
   `contextLimit`, the next window must be **larger** — otherwise the same
   context cannot fit and the retry is skipped. Unknown windows keep the retry
   possible.

`isFree` is explicit on the entry because the core has no price data: absent
means paid. Free entries bypass an exhausted cap; a missing flag is never read
as free.

## Usage ledger

`UsageLedger` keeps per-day usage under an injected directory:

- one `YYYY-MM-DD.jsonl` per **local** day, day boundary from an injected clock;
- rows `{ at, providerID, modelID, turns, costMicros, isFree? }`, appended under
  a small in-process lock with `O_APPEND | O_CREAT | O_NOFOLLOW`, mode `0600`;
- `isFree` is written only when the answered model is explicitly free. A row
  without the flag — including every row written before this counter existed —
  counts as **paid** (`paidTurnsToday()`), the conservative direction for a
  budget. `costMicros` stays `0`: this slice meters turns, not money;
- a 4 MiB cap **refuses** the row with `usage_ledger_full` instead of rotating
  away the day's history;
- day files older than `USAGE_LEDGER_RETENTION_DAYS` (default 30) are removed on
  the first write of a local day, so the directory cannot grow without bound;
  pruning is best-effort and never fails the turn;
- a corrupt line is skipped and counted (`skippedToday()`), never thrown.

## Wiring points (implemented in #35)

- prompt admission resolves the policy (chat from settings); when the browser
  sent a model, its host model id resolves to attempt 1's `ModelRef` (provider
  plus optional variant and known context window) and the chain is only the
  tail. Only a missing/unresolvable client model falls back to the first chain
  entry;
- the turn is registered **before** the prompt is submitted, so text the host
  emits while the POST is still open is already observed;
- the event loop tracks `attempts`, accumulated `session.text.delta` text and
  `tried`; on `session.execution.failed` it calls `shouldFallback`;
- on `true`: switch to `next`, re-prompt the same text once, append to `tried`.
  The host appends a **new user message per prompt**, so the retry leaves the
  failed attempt and a duplicate user message in the history; nothing is
  rewritten;
- on completion: `ledger.record(...)` and emit `TurnOutcome`
  (`requested`, `answered`, `fellBack`, `reason`, `attempts`), where `attempts`
  counts the successful attempt and every failed one before it;
- the UI renders one i18n notice; the fake backend gets a scripted failure so
  the flow is provable without a provider.

The implemented wiring is documented in
[`35-fallback-wiring.md`](./35-fallback-wiring.md).

## Tests

`packages/contracts/test/turn-policy.test.ts` (chain bounds, duplicates,
surface), `apps/server/test/fallback-policy.test.ts` (classification matrix,
no fallback after text, one retry only, paid-turn cap, free bypass, code
surface, context-window gate), `apps/server/test/usage-ledger.test.ts` (append,
day rollover, corrupt lines, `0600`, injected directory, cap refusal, paid-turn
counting, old rows without `isFree`, retention pruning).
