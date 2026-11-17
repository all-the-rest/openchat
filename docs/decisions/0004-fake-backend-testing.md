# ADR 0004 — Fake Backend and Zero-Quota Tests

**Status:** accepted (2026-11-17)
**Deciders:** owner, orchestrator

## Context

The owner wants tests that never spend real provider quota, E2E coverage with
mocked endpoints, and a way to try the UI without a paid model. OpenCode itself
is cheap to run but every prompt costs tokens against a provider.

## Decision

1. Keep the `ChatBackend` port and ship a deterministic in-memory fake
   implementation from M1.
2. Run unit, integration and E2E tests against the fake with no network.
3. Provide fake STT for dictation tests.
4. Keep a live smoke test opt-in (`LIVE_TESTS=1`), capped and outside CI.
5. Expose `BACKEND_MODE=fake` as a supported development mode.

## Rationale

- No quota in CI, no flaky external dependency, no secrets in test runs.
- The fake emits the real event envelope, so normalization, folding, retries and
  cancellation are all exercised.
- A fake model is also the only way to test failure modes (rate limit, abort,
  malformed tool output) reliably.
- The live smoke still catches contract drift that types cannot.

## Consequences

- The fake must be maintained alongside the adapter and the client version.
- Tests can drift from real behavior if fixtures are stale; the opt-in live
  smoke is the counterweight.
- `BACKEND_MODE=fake` must never be reachable in production; refuse to start
  with `NODE_ENV=production` and `BACKEND_MODE=fake`.

## Revisit criteria

- The fake diverges from real event ordering in a way that breaks a release.
- A provider offers a free tier that CI may use safely and reproducibly.
