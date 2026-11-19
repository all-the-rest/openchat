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
- `FALLBACK_PAID_DAILY_CAP` — the daily paid budget; `0` means the cap is **off**.
- `FALLBACK_USAGE_DIR` — where the usage ledger writes per-day records; defaults
  to `/workspace/chats/.usage`.
- `CHAT_CONTEXT_SOFT_CAP` — reused from the compaction slice; the fallback engine
  only reads it as part of the same policy object and does not enforce it.

`resolveChatPolicy` builds the chat `TurnPolicy` from these values and validates
the chain with `turnPolicySchema`: at most five entries and no duplicate keys
(duplicate `providerID + modelID + variant` is rejected). The Code surface uses
`CODE_POLICY` — an empty chain and zero caps — **by construction**: it proxies
OpenCode directly and never enters the BFF prompt route, so none of this wiring
runs for it.

## Admission (`prompt-route.ts`)

The prompt route resolves the policy once per turn, calls `requestedModel(policy)`
to pick the chain's first entry, and passes that `modelRef` into
`backend.prompt(...)`. It then registers the turn with `FallbackEngine.begin`,
which gives the engine the policy, the submitted text and the initial `modelRef`
so it can track `attempts`, emitted text and tried models as events arrive.

## Event loop (`events-route.ts`)

The events route feeds observed events to the engine. On
`session.execution.failed` the engine classifies the failure and calls
`shouldFallback`. A switch happens only when **all** hold: chat surface, first
attempt, no assistant text emitted (whitespace counts as text), a retryable
reason, a next untried chain entry, and — for a paid entry — room under the daily
cap.

When the decision is `true`, the engine:

1. **suppresses** the failed event (it is not forwarded to the client);
2. re-prompts the same text once with `modelRef: next`, appending `next` to
   `tried`;
3. emits a translated `chat.fallback.notice` and a `turn.outcome` for the turn.

Per the owner decision, **there is no history rewrite**: the failed turn stays
visible and the retry appends a new attempt on the next model. At most one retry
per turn is possible because the first-attempt condition fails on the second
failure.

## Usage ledger and the paid cap

On a successful (answered) turn the engine writes a per-day record under
`FALLBACK_USAGE_DIR`, using the same injected-directory ledger as the policy
slice. The paid cap is checked **before** a retry is issued, from the ledger's
spend-so-far for the local day; free entries (`isFree === true`) bypass the cap,
and a missing flag is never read as free. The ledger records usage only — this
slice adds no token-based cost metering.

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
failure **before any text**. It also records the `modelRef` it was prompted with,
so tests can assert that admission and the retry used the expected chain entries.

## Tests

- `apps/server/test/fallback-engine.test.ts` — the decision state machine: a
  retryable first-attempt failure re-prompts once with a *different* `modelRef`,
  no fallback after emitted text (including reasoning/tool output), no second
  retry, the paid cap checked before a paid retry, free bypass, one `turn.outcome`
  on success, untracked sessions forward the failure, and queued/cancelled turns
  are not retried.
- `apps/server/test/fallback-wiring.test.ts` — prompt admission resolves the
  chat policy and passes the first `modelRef` into `backend.prompt` (and skips
  turn registration for a queued send); the SSE route observes events, consults
  the engine on failure/success, and writes synthetic events when a failure is
  suppressed. The Code surface never enters this path: it proxies OpenCode
  directly and is empty-policy by construction.
- `apps/web/test/fold.test.ts` — the synthetic `chat.fallback.notice` SSE event
  folds into one localized (en/de) i18n system message, and `turn.outcome` does
  not render as a message.
- `packages/opencode/test/fallback-fake.test.ts` — the `fallback:` prefix emits a
  retryable `rate_limit` before any text, is one-shot so the retry can succeed,
  and records the `modelRef` for assertions.

The existing `apps/server/test/fallback-policy.test.ts` and usage-ledger tests
continue to cover the decision rules and ledger mechanics; these files cover
only the wiring on top of them.

Gates before any commit: `pnpm run gates:fast` (lint, typecheck, test, build,
`ratchet check --tier fast`).
