# Documentation

## Reading order

1. **Clean room** — how observation and separation work.
2. **Specification** — the only input for the builder.
3. **Architecture** — how the application is built.
4. **Matrix** — what OpenCode can and cannot do.
5. **Roadmap** — the order of implementation.

## Clean room

| File | Content |
| --- | --- |
| [`clean-room/00-method.md`](clean-room/00-method.md) | Method, roles, evidence, legal, privacy |
| [`clean-room/01-observation-log.md`](clean-room/01-observation-log.md) | Raw observations with evidence IDs |
| [`clean-room/02-surface-inventory.md`](clean-room/02-surface-inventory.md) | Surfaces and states |
| [`clean-room/03-rendering-matrix.md`](clean-room/03-rendering-matrix.md) | What the reference can render |
| [`clean-room/04-design-tokens.md`](clean-room/04-design-tokens.md) | Measured layout and design values |
| [`clean-room/05-contamination-log.md`](clean-room/05-contamination-log.md) | Contamination and countermeasures |
| [`spec/11-implementation-brief.md`](spec/11-implementation-brief.md) | Builder onboarding |

## Specification

The filter between observation and implementation. The builder reads only this
folder (plus architecture and features).

| File | Content |
| --- | --- |
| [`spec/README.md`](spec/README.md) | Rules and document plan |
| [`spec/01-product-scope.md`](spec/01-product-scope.md) | Product scope and non-functional requirements |
| [`spec/02-information-architecture.md`](spec/02-information-architecture.md) | Navigation and surfaces |
| [`spec/03-chat-lifecycle.md`](spec/03-chat-lifecycle.md) | Send, stream, cancel, errors |
| [`spec/04-composer.md`](spec/04-composer.md) | Input, attachments, models, tools |
| [`spec/05-rendering.md`](spec/05-rendering.md) | Message and artifact rendering |
| [`spec/06-agents-tasks.md`](spec/06-agents-tasks.md) | Agents, planning, todos, schedules |
| [`spec/07-settings-auth.md`](spec/07-settings-auth.md) | Settings, providers, auth |
| [`spec/08-design-tokens.md`](spec/08-design-tokens.md) | Design system |
| [`spec/09-accessibility.md`](spec/09-accessibility.md) | Keyboard, screen readers, reduced motion |
| [`spec/10-acceptance.md`](spec/10-acceptance.md) | Acceptance criteria |
| [`spec/12-i18n.md`](spec/12-i18n.md) | Internationalization (en/de) |
| [`spec/14-interactive-patterns.md`](spec/14-interactive-patterns.md) | Reusable interactive chat patterns (P-01 … P-11) |

## Architecture

| File | Content |
| --- | --- |
| [`architecture/01-system.md`](architecture/01-system.md) | Components, data flow, options |
| [`architecture/02-opencode-integration.md`](architecture/02-opencode-integration.md) | API, events and SDK usage |
| [`architecture/03-auth-deployment.md`](architecture/03-auth-deployment.md) | Single-user auth, network, deployment |
| [`architecture/04-artifact-sandbox.md`](architecture/04-artifact-sandbox.md) | Safe rendering of agent HTML |
| [`architecture/05-testing.md`](architecture/05-testing.md) | Fake backend, zero-quota tests, E2E |
| [`architecture/06-code-surface.md`](architecture/06-code-surface.md) | Code host, ticket flow, CSP |
| [`architecture/07-artifact-runtime.md`](architecture/07-artifact-runtime.md) | Interactive apps: tool, build, shell |

## Other

| File | Content |
| --- | --- |
| [`matrix/01-feasibility.md`](matrix/01-feasibility.md) | Feasibility matrix |
| [`research/opencode-capabilities.md`](research/opencode-capabilities.md) | Evidence-backed OpenCode capabilities |
| [`research/opencode-web-gate-parity.md`](research/opencode-web-gate-parity.md) | Successor parity with `opencode-web-gate` |
| [`research/interactive-chat-elements.md`](research/interactive-chat-elements.md) | Inline interactive elements in a normal chat (OBS-040) |
| [`research/codex-luna-low.md`](research/codex-luna-low.md) | Codex mode run: timeline, file output, timing |
| [`research/plan-mode.md`](research/plan-mode.md) | Scheduled-tasks surface (OBS-042) |
| [`implementation/01-m1-m2.md`](implementation/01-m1-m2.md) | What runs today: API, scenarios, renderers, tests, limits |
| [`implementation/02-ui-review.md`](implementation/02-ui-review.md) | First visual pass at four breakpoints; findings and coverage |
| [`implementation/14-deployment.md`](implementation/14-deployment.md) | Compose stack, tool runtime, guards, cutover |
| [`roadmap.md`](roadmap.md) | Phases and milestones |
| [`decisions/`](decisions/) | Architecture Decision Records |
