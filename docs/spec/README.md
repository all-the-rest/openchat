# Specification

This folder is the **clean-room filter**. The builder reads it; the builder does
not read `docs/reference/**` or the observation logs.

## Rules

- Requirements are functional and testable, not implementation instructions.
- Every requirement has an ID (`FR-…`, `NFR-…`, `UX-…`) and an acceptance
  criterion.
- No screenshots, DOM dumps, copied code, copied CSS or reference assets.
- Measurements and colors are allowed as values, not as stylesheet excerpts.
- Open questions are marked `OPEN:` and block the affected requirement.

## Documents

| File | Content |
| --- | --- |
| `01-product-scope.md` | scope, personas, functional and non-functional requirements |
| `02-information-architecture.md` | routes, navigation, surfaces |
| `03-chat-lifecycle.md` | send, stream, cancel, error, retry, branch |
| `04-composer.md` | input, attachments, model/agent picker, tools |
| `05-rendering.md` | message and artifact renderers |
| `06-agents-tasks.md` | agents, todos, schedules, worktrees |
| `07-settings-auth.md` | login, settings, providers, MCP |
| `08-design-tokens.md` | design system values |
| `09-accessibility.md` | keyboard, screen readers, motion, contrast |
| `10-acceptance.md` | end-to-end acceptance scenarios |
| `11-implementation-brief.md` | builder onboarding and first slice |
| `12-i18n.md` | internationalization rules and copy conventions |
