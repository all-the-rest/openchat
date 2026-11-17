# 05 — Testing and the Fake Backend

Owner requirement (2026-11-17): tests must never consume real provider quota,
and E2E must run against mocked endpoints and a fake model. The same fake
backend doubles as a development mode so the UI can be exercised without a
provider.

## Layers

| Layer | Runs against | Network | Purpose |
| --- | --- | --- | --- |
| Unit | pure functions | none | event folding, validators, reducers, i18n |
| Contract | `@opencode/client` types + recorded fixtures | none | payload shapes, error mapping |
| Integration | fake `ChatBackend` | none | prompt → events → transcript |
| E2E | BFF with `BACKEND_MODE=fake` + fake STT | none | login, send, stream, stop, permission, artifact |
| Live smoke | real `opencode serve` | loopback | opt-in, capped, never in CI |

## Fake `ChatBackend`

One implementation of the `ChatBackend` port, no HTTP:

- Sessions, messages and artifacts live in memory, seeded per scenario.
- `prompt()` returns a scripted inbox entry, then emits an event sequence with
  configurable delays: `session.inbox.enqueued`, `delivered`,
  `session.execution.started`, `session.step.*`, `session.text.*`,
  `session.tool.*`, `session.usage.updated`, `session.execution.succeeded`.
- Scenarios: `default` (short answer), `reasoning`, `tools`, `permission`,
  `form`, `artifact`, `error`, `rate-limit`, `slow`, `abort`, `compaction`.
- Emits the real envelope shape `{ id, created, type, data, durable? }`, so the
  normalizer is tested, not bypassed.
- Supports interruption: `interrupt()` stops the script at the next step and
  leaves the partial text.
- Deterministic: fixed ids, fixed timestamps from a seeded clock, no `Date.now`
  in assertions.

## Fake STT

- `POST /api/transcribe` in tests goes to an in-process fake that returns a
  fixed transcript and records duration/size.
- Failure modes: 401, 413, timeout, empty transcript, unsupported MIME.
- No audio is written anywhere; the test asserts the BFF keeps it in memory.

## E2E

- Playwright starts the BFF with `BACKEND_MODE=fake` and a fixed `FAKE_SCENARIO`.
- The browser never needs an OpenCode process, a model key or network access.
- Permissions and forms are scripted events, so approval flows are testable.
- Artifact tests use a local artifact host on a second port with the real CSP
  and sandbox; the iframe still runs untrusted HTML.
- Screenshots are optional and never contain personal data.

## Contract tests

- Generate types from the pinned OpenCode OpenAPI in CI and fail on drift that
  affects the methods we call.
- Keep redacted fixtures of real responses (`docs`-free, no prompts) under
  `packages/opencode/fixtures/`.
- Every client method used by the BFF has a test that decodes a fixture into the
  normalized type.

## Live smoke (opt-in)

- `LIVE_TESTS=1`, an explicit `OPENCODE_URL` and a dedicated cheap model.
- Hard budget: one short prompt, no tools unless the scenario requires it, and
  a timeout that aborts the run.
- Excluded from CI and from `bun run test`; a separate `bun run test:live`.
- Never runs with the owner's default model by accident; require
  `LIVE_MODEL=provider/model`.

## Rules

- No test imports `docs/clean-room/**` or `docs/reference/**`.
- No secrets or personal data in fixtures.
- A failing live test is an investigation, not a reason to retry against the
  paid provider.
- The fake backend is a product surface: `BACKEND_MODE=fake` must stay usable
  for manual UI work.
