# 05 — Testing and the Fake Backend

Owner requirement (2026-11-17): tests must never consume real provider quota,
and E2E must run against mocked endpoints and a fake model. The same fake
backend doubles as a development mode so the UI can be exercised without a
provider.

## Quality gates

Two tiers, both runnable locally:

| Tier | Command | Budget | Contents |
| --- | --- | --- | --- |
| Fast | `pnpm run gates:fast` | seconds | `pnpm run lint`, `typecheck`, `test`, `build`, then `ratchet check --tier fast` |
| Slow | `pnpm run test:e2e`, `pnpm --filter @openchat/web run test:screenshots` | minutes | Playwright against the fake BFF (8787) and Vite (5173): four parallel functional tests on four workers, then the UI-review captures (four breakpoints, theme/locale/interaction variants) |

The fast ratchet rules live in `ratchet.config.jsonc` and are pinned by
`ratchet.baseline.json`:

- `ui-review-blockers` — open UI-review findings at critical or high severity;
  counts `ratchet.findings.json` entries with status `open` or `in-progress`.
- `i18n-literals` — hard-coded user-visible strings in the web UI; counts the
  same scan as `scripts/lint-i18n.ts`.
- `test-count` — declared functional test cases: `it`/`test` declarations in
  `*.test.{ts,tsx,mts,cts}` files under `apps/**` and `packages/**` plus the
  functional `*.spec.{ts,tsx,mts,cts}` files under `apps/web/e2e/**`;
  `scripts/count-tests.ts` counts them, skipping the `apps/web/screenshots`
  harness (capture machinery, not tests). **Floor:** the suite may grow, never
  shrink. When the scope was introduced at `3ae6739` it counted 149
  declarations: 148 unit/component tests plus one E2E spec. The baseline reads
  163 — that 149, plus eleven `it` declarations in the counter's own fixture
  file (`apps/server/test/ratchet-counters.test.ts`), plus three further E2E
  tests (the single spec was split into four).
- `file-length` — first-party code files over 400 lines (`apps/**`,
  `packages/**`, `scripts/**`); `scripts/count-long-files.ts` counts files
  strictly greater than 400 lines. **Ceiling:** the limit is 400, new oversized
  files need a split, not a baseline update.

The fast tier floor is four rules, so a run that selects nothing fails instead
of passing vacuously.

The fast tier needs `ratchet` 0.6.3 on `PATH`; the binary is not vendored.
After fixing debt, move the baseline in its allowed direction with
`ratchet baseline update` (for `test-count` that means the baseline follows a
larger suite; for the ceilings it follows a smaller count). A deliberate move
against the direction is
`ratchet baseline raise --rule <id> --value <n> --reason "<text>"`. The
counters themselves are the single source of truth: `ratchet count` shows the
current numbers, and each counter prints only an integer without arguments
(`node scripts/count-tests.ts`, `node scripts/count-long-files.ts`); `--list`
shows the per-file breakdown for humans.

CI runs the fast job (`lint`, `typecheck`, `test`, `build`), the `ratchet` job
(`ratchet check --tier fast`, all four rules), and the slow job: the four
parallel E2E tests on four workers first, then the screenshot set in the same
runner (Chromium is already installed). All E2E tests share one fake backend
instance; isolation comes from each test logging in and creating its own chat,
not from a global scenario or session count. `retries: 0` stays deliberate in
local runs and CI: a parallel suite must be stable without reruns, so a flake is
a defect, not a retry candidate. The captures are uploaded as the
`ui-review-screenshots` artifact on every outcome, so a failed run leaves the
images that explain it. Neither slow step consumes provider quota; both boot the
fake backend.

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

- Five independent tests (`auth`, `render`, `stop`, `preferences`, `dictation`), each in its
  own file, run `fullyParallel: true` on four workers from the first second.
- The backend is shared and in memory, so it already holds the other tests'
  chats. Every test logs in and creates its own chat, then asserts on the
  active sidebar entry (`session-item[aria-current="page"]`) and that chat's
  transcript; global counts and `session-item.first()` would be racy.
- The `slow:` scenario streams twelve sentences in 22-character chunks at 400 ms
  per chunk, which leaves roughly 5.6 s between the first chunk and the end of
  the run. The stop click has a comfortable window even while three other
  browsers compete for CPU; chunk size and delay stay fixed.
- `retries: 0` in local runs and CI: parallelism must be stable without reruns.
- Playwright starts the BFF with `BACKEND_MODE=fake` and a fixed `FAKE_SCENARIO`.
- The browser never needs an OpenCode process, a model key or network access.
- Permissions and forms are scripted events, so approval flows are testable.
- Artifact tests use a local artifact host on a second port with the real CSP
  and sandbox; the iframe still runs untrusted HTML.
- Interactive apps are tested from fixture components (`calculator`, `chart`,
  `broken`, `cdn`) through the real validator and shell assembly; no model is
  called. The validator table covers CDN URLs, `fetch`, `eval`, storage,
  `</script`, oversize and syntax errors with position.
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
- Excluded from CI and from `pnpm run test`; run with `LIVE_TESTS=1 pnpm run test`
  so the suite keeps one entry point and the guard is an env var, not a second
  script.
- Never runs with the owner's default model by accident; require
  `LIVE_MODEL=provider/model`.

## Rules

- No test imports `docs/clean-room/**` or `docs/reference/**`.
- No secrets or personal data in fixtures.
- A failing live test is an investigation, not a reason to retry against the
  paid provider.
- The fake backend is a product surface: `BACKEND_MODE=fake` must stay usable
  for manual UI work.
