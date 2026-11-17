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
| [`clean-room/06-implementation-brief.md`](clean-room/06-implementation-brief.md) | Builder onboarding |

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

## Architecture

| File | Content |
| --- | --- |
| [`architecture/01-system.md`](architecture/01-system.md) | Components, data flow, options |
| [`architecture/02-opencode-integration.md`](architecture/02-opencode-integration.md) | API, events and SDK usage |
| [`architecture/03-auth-deployment.md`](architecture/03-auth-deployment.md) | Single-user auth, network, deployment |
| [`architecture/04-artifact-sandbox.md`](architecture/04-artifact-sandbox.md) | Safe rendering of agent HTML |

## Other

| File | Content |
| --- | --- |
| [`matrix/01-feasibility.md`](matrix/01-feasibility.md) | Feasibility matrix |
| [`research/opencode-capabilities.md`](research/opencode-capabilities.md) | Evidence-backed OpenCode capabilities |
| [`roadmap.md`](roadmap.md) | Phases and milestones |
| [`decisions/`](decisions/) | Architecture Decision Records |
