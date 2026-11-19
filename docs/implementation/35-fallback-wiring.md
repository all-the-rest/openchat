# 35 — Fallback wiring

**Status:** 2026-11-19. Implements issue #54. This page documents the prompt/SSE
wiring that makes the policy in [`33-fallback-policy.md`](./33-fallback-policy.md)
run; it does not restate the rules.

The wiring stays entirely on the chat path in the BFF. It resolves one policy at
admission, lets a single `FallbackEngine` observe the turn's events, and on a
qualifying early failure re-prompts once on the next model. It never rewrites
history, never changes the Code surface and never meters cost from tokens —
those are explicitly out of this slice.

## Configuration and policy resolution

Four environment values feed the chat policy:

- `FALLBACK_CHAIN_JSON` — a JSON array of `ModelRef`; an empty array (the default
  meaning) is **no chain**, so fallback is inert unless a chain is configured.
  A non-empty but invalid value keeps fallback disabled and emits **one boot
  warning** with the validation message; the raw value is never logged.
- `FALLBACK_PAID_DAILY_CAP` — **paid turns per local day**; `0` means the cap is
  **off**. Free turns never count; a row without the free flag counts as paid.
- `FALLBACK_USAGE_DIR` — where the usage ledger writes per-day records; defaults
  to `/workspace/chats/.usage`.
- `CHAT_CONTEXT_SOFT_CAP` — reused from the compaction slice; the fallback engine
  only reads it as part of the same policy object and does not enforce it.

`resolveChatPolicy` builds the chat `TurnPolicy` from these values and validates
the chain with `turnPolicySchema`: at most five entries and no duplicate keys
(duplicate `providerID + modelID + variant` is rejected). The Code surface has
no policy constant and no chain: it proxies OpenCode directly and never enters
the BFF prompt route, so none of this wiring runs for it. A wiring test asserts
that a Code-surface request touches neither the engine nor the ledger.

## Admission (`prompt-route.ts`)

The prompt route resolves the policy once per turn. When a chain is configured
and the browser sent `model`, that client choice becomes attempt 1's `modelRef`;
the chain is only the tail. The browser sends a host model **id** (`fake/echo`,
which may itself contain a slash), so the route resolves the provider from a
matching chain entry first and otherwise from the host catalogue; only without a
catalogue is the value read as `providerID/modelID`. A variant is kept only when
the model still offers it. Only a missing or unresolvable client model falls
back to the chain's first entry. Without a configured chain the existing path is
untouched, so the live adapter still validates the persisted model against the
catalogue. The route then registers the turn with `FallbackEngine.begin`
**before** `backend.prompt`, with no message id yet. `adopt` takes the id from
the response.

If the submit throws or reports `queued: true`, the registration is abandoned:
`abandon` restores the turn it replaced, so a queued send cannot overwrite — let
alone retry — the active turn. `queued: undefined` (the live probe failed) is
"not queued": the prompt did start the run and stays tracked.

A queued turn is **not** promoted when `session.execution.started` arrives: that
event carries the assistant message id but neither the queued user text nor its
message id, so the engine would have to guess which text to retry. The
limitation is deliberate; the active turn keeps its own state.

One residual race is accepted: while a queued send is being registered, a delta
that belongs to the still-streaming active turn arrives at the new state and is
dropped by `abandon`. The restored active turn then has no recorded output and
could be retried after it printed. It needs a queued send within the same few
milliseconds as a live delta on a single-user deployment; closing it would mean
correlating deltas by message id, which the event contract does not carry.

## Event loop (`events-route.ts`)

The events route feeds observed events to the engine. On
`session.execution.failed` the engine classifies the failure and calls
`shouldFallback`. A switch happens only when **all** hold: chat surface, first
attempt, no assistant text emitted (whitespace counts as text), a retryable
reason, a next untried chain entry, a paid turn left under the daily cap for a
paid entry, and — for `context_overflow` — a next entry that either has an
unknown window or a strictly larger one.

When the decision is `true`, the engine:

1. **suppresses** the failed event (it is not forwarded to the client);
2. re-prompts the same text once with `modelRef: next`, appending `next` to
   `tried`;
3. emits a translated `chat.fallback.notice`; the outcome is emitted when the
   retry actually completes.

A synchronous per-session "retrying" guard is set before the first `await` and
cleared on every exit path, so two `/api/events` subscribers that both see the
same failure re-prompt only once; the second forwards the original failure.

Per the owner decision, **there is no history rewrite**: the failed turn stays
visible and the retry appends a new attempt on the next model. The host appends
a new user message per prompt, so the history shows the failed attempt plus a
**duplicate user message** for the retry. At most one retry per turn is possible
because the first-attempt condition fails on the second failure.

## Usage ledger and the paid cap

On a successful (answered) turn the engine writes a per-day record under
`FALLBACK_USAGE_DIR`. The record marks `isFree: true` only for an explicitly
free answered model; every other row — including rows written before the flag
existed — counts as a paid turn. The cap is checked **before** a retry is
issued, from `paidTurnsToday()` for the local day; free entries
(`isFree === true`) bypass the cap, and a missing flag is never read as free.
`costMicros` stays `0`: this slice adds no token-based cost metering.

## Settings surface (issue #54, item 4)

`GET /api/fallback` (`apps/server/src/fallback-route.ts`) reports the effective,
non-secret configuration: `configured`, the ordered chain entries
(`providerID`, `modelID`, optional `variant`, `isFree`, `contextLimit`),
`paidDailyCap` and today's `paidTurnsToday`/`turnsToday`. It is built from the
same resolved `TurnPolicy` the prompt route enforces and reads the same
`UsageLedger` the engine writes, so the answer cannot drift from enforcement;
the raw `FALLBACK_CHAIN_JSON` value, credentials and the ledger path are never
part of it. A rejected `FALLBACK_CHAIN_JSON` is not reported as "nothing
configured": the route sets `invalid: true` with a short `invalidReason` that
names the broken rule, and `configured`/`chain` stay empty because fallback is
off. The settings page shows it in the "Model fallback" block
(`apps/web/src/components/FallbackSettings.tsx`): the chain in order, the cap
("N paid turns per day" or off) and today's paid turn count, with loading,
error, retry and invalid-chain states. `apps/server/test/fallback-route.test.ts`
and `apps/web/test/fallback-settings.test.tsx` cover those states.

## Notice delivery

The POST response has already returned by the time a failure is observed, so the
notice is delivered as a **synthetic SSE event** on the open stream. The web
`fold.ts` folds `chat.fallback.notice` into exactly one system message in the
thread, using an i18n string (`en`/`de`). `turn.outcome` is observability only: it
carries `requested`, `answered`, `fellBack`, `reason` and `attempts`, and is not
rendered as a message.

## Fake backend

The fake backend gains a scriptable failure so the flow is provable without a
provider: a prompt text prefixed with `fallback:` emits a retryable `rate_limit`
failure **before any text**; `fallback-text:` streams one delta first and then
emits the same failure, proving that output arriving while the POST is still
open blocks the retry. Both are one-shot so the retry can succeed. The fake also
records the `modelRef` it was prompted with, so tests can assert that admission
and the retry used the expected chain entries; the 15 ms scenario pause is
unchanged (a test that needs a wider window delays its own response instead).

## Tests

- `apps/server/test/fallback-engine.test.ts` — the decision state machine: a
  retryable first-attempt failure re-prompts once with a *different* `modelRef`,
  no fallback after emitted text (including reasoning/tool output), no second
  retry, two concurrent subscriber reports cause only one retry, the paid-turn
  cap checked before a paid retry, free bypass, `attempts: 2` on a successful
  retry, the free flag reaching the ledger, abandoned registrations restoring
  the replaced turn, untracked sessions forward the failure, and cancelled turns
  are not retried.
- `apps/server/test/fallback-wiring.test.ts` — prompt admission lets the client
  model win attempt 1 with the chain as tail, registers the turn before submit
  (and the SSE route only retries when no text arrived before the response),
  observes events on failure/success, writes synthetic events when a failure is
  suppressed, drops a queued send while keeping the active turn, leaves the Code
  surface out of the engine and the ledger, warns once about invalid chain JSON
  without logging its value, and asserts the duplicated user message a retry
  leaves in the history.
- `apps/web/test/fold.test.ts` — the synthetic `chat.fallback.notice` SSE event
  folds into one localized (en/de) i18n system message, and `turn.outcome` does
  not render as a message.
- `packages/opencode/test/fallback-fake.test.ts` — the `fallback:` prefix emits a
  retryable `rate_limit` before any text, `fallback-text:` streams a delta first,
  both are one-shot so the retry can succeed, and the `modelRef` is recorded for
  assertions.

The existing `apps/server/test/fallback-policy.test.ts` and usage-ledger tests
continue to cover the decision rules and ledger mechanics; these files cover
only the wiring on top of them.

Gates before any commit: `pnpm run gates:fast` (lint, typecheck, test, build,
`ratchet check --tier fast`).
