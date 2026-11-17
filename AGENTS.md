# AGENTS.md

## Language

- Documentation, code, identifiers, commit messages and technical comments:
  **English**.
- Product UI: **i18n with English and German** (`en`, `de`). No hard-coded UI
  strings; every user-visible string goes through the translation layer.
- The UI language is selectable and persisted per user. Default follows the
  browser locale, falling back to English.
- Exceptions only when a file already uses another language.

## Tracker

GitHub Issues in `all-the-rest/openchat` are the only task tracker. No
local task lists as the source of truth.

- Commits link their issue: `Refs #N` or `Closes #N`.
- Completed work is summarized in the issue and the issue is closed.
- Deliberately abandoned work is justified in the issue and closed.

## Clean Room (hard rules)

1. **Do not copy code, assets or text from the reference.**
   This includes HTML/CSS/JS bundles, SVG icons, logos, fonts, screenshots used
   as production assets, prompt text and UI copy.
2. **Document observable behavior only.** Layout measurements, colors, state
   transitions, interaction flows and response shapes are allowed — as facts
   with an evidence ID, not as code.
3. **Never commit raw material.** Screenshots, DOM dumps, HAR files and network
   captures live in `references/raw/` (gitignored). `docs/reference/` contains
   only redacted, necessary excerpts.
4. **Do not bypass auth, paywalls, rate limits or DRM.** Observe only with your
   own account and your own data.
5. **No third-party data.** Redact chat titles, message content, cookies and
   tokens. Do not commit screenshots containing personal data.
6. **Independent product identity.** No "ChatGPT", "OpenAI" or logo imitation
   in the product name, metadata or marketing.
7. **Role separation.** The `observer` writes observations and the
   specification. The `builder` reads only `docs/spec/**`,
   `docs/architecture/**`, `docs/decisions/**` and `features/**` — never
   `docs/reference/**` or the raw observation logs.
8. **Log contamination.** Every encounter with reference code or assets goes
   into `docs/clean-room/05-contamination-log.md`.

## Roles

| Agent | May read | May write |
| --- | --- | --- |
| `observer` | all reference material | `docs/reference/**`, `docs/clean-room/01-*` … `05-*`, `docs/spec/**` |
| `builder` | `docs/spec/**`, `docs/architecture/**`, `docs/decisions/**`, `features/**`, code | `apps/**`, `packages/**`, `features/**`, tests, root build config (`package.json`, lockfile), `docs/architecture/**`; reports decisions, the orchestrator records the ADR |
| `reviewer` | everything | review notes in the issue only |

The project default agent is `observer` while the analysis is running (M0).
Switch to `builder` for implementation work; the permissions are the
enforcement, the default is only a convenience.

Permissions are enforced in `.opencode/agents/*.md`. The separation is a
process rule; a single model cannot be forced to obey it if an agent ignores
it. Therefore: separate sessions, separate roles, no reference in the builder
context.

## Engineering

- Package manager: pnpm (workspaces in `pnpm-workspace.yaml`). Do not add a
  second package manager.
- Frontend: React + Vite + TypeScript.
- Styling: Tailwind CSS 4 + daisyUI 5 over the semantic tokens in
  `docs/spec/08-design-tokens.md` (ADR-0007). Chat-specific surfaces are our own
  components; daisyUI covers the generic controls.
- BFF: Node + Hono, same-origin.
- Backend: OpenCode V2 via `@opencode/client`; optional `@opencode/sdk`.
- Tests: Vitest + Playwright. Every change ships tests.
- Quality gates before commit: `pnpm run lint`, `pnpm run typecheck`,
  `pnpm run test`, `pnpm run build`, `ratchet check --tier fast` (or
  `pnpm run gates:fast`).
- CodeGraph index in `.codegraph/`; `.githooks/pre-commit` runs `codegraph sync`.
  Prefer `codegraph explore` over grep for architecture questions.
- Build agents do not commit or push; the orchestrator commits and reviews
  dependency and script changes in the diff.

## Security

- No secrets in the repo, the client or logs.
- Never bind OpenCode publicly; expose it only through the BFF or an internal
  network.
- Run artifacts and agent-generated HTML only in a sandboxed iframe on a
  separate origin.
- Permissions and tool approvals are security boundaries, not UI decoration.
