# 06 — Implementation Brief

Onboarding for the builder. Read this, then the specification.

## Read order

1. `docs/spec/01-product-scope.md`
2. `docs/spec/02-information-architecture.md`
3. `docs/spec/03-chat-lifecycle.md`
4. `docs/spec/04-composer.md`
5. `docs/spec/05-rendering.md`
6. `docs/spec/06-agents-tasks.md`
7. `docs/spec/07-settings-auth.md`
8. `docs/spec/08-design-tokens.md`
9. `docs/spec/09-accessibility.md`
10. `docs/spec/10-acceptance.md`
11. `docs/architecture/01-system.md` and the relevant ADRs.

## Do not read

- `docs/reference/**`
- `docs/clean-room/01-*` through `05-*`
- `references/**`
- The reference app, its bundles or assets.

If a detail is missing, stop and report the open question. Do not guess and do
not open the reference.

## First vertical slice (M1)

Build the smallest end-to-end path:

1. Bun workspace with `apps/web`, `apps/server`, `packages/opencode`.
2. Basic auth (or a stub behind an env flag).
3. `GET /healthz` and a typed OpenCode client.
4. Session list + new chat + prompt + SSE stream + stop.
5. A plain transcript: user text, assistant text, error.
6. Playwright smoke test.

Do not build the design system, artifacts or settings before this works.

## Non-negotiables

- No secrets in the client.
- OpenCode internal only.
- All UI strings through i18n (`en`, `de`).
- No `allow-same-origin` with `allow-scripts`.
- Tests for every change.
- No commits or pushes; report back to the orchestrator.

## Definition of done for a slice

- Acceptance scenarios for the slice pass.
- `bun run lint`, `bun run test`, `bun run build` pass.
- New UI has keyboard access and visible focus.
- New backend calls have timeouts, cancellation and user-visible errors.
- The issue is updated with what changed and what remains.
