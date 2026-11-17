# AGENTS.md

OpenChat — clean-room, self-hosted chat UI over OpenCode. Single user, English
documentation, English/German UI.

## Hard rules

- **Clean room.** Never copy code, assets, UI text or prompts from the
  reference. Document observable behaviour only, with evidence IDs. Raw captures
  stay in `references/raw/` (gitignored); only redacted excerpts go to
  `docs/reference/`. No third-party data, no auth/paywall/DRM bypass, no
  "ChatGPT"/"OpenAI" branding. Log every encounter in
  `docs/clean-room/05-contamination-log.md`.
- **Roles.** `observer` writes observations and the spec. `builder` reads only
  `docs/spec/**`, `docs/architecture/**`, `docs/decisions/**`, `features/**` —
  never `docs/reference/**` or raw logs. `reviewer` reads everything, writes
  review notes in the issue only. Separate sessions per role; permissions live
  in `.opencode/agents/*.md`.
- **Language.** Docs, code, identifiers, commits: English. Every user-visible
  string goes through i18n (`en`, `de`); no hard-coded UI text.

## Workflow

- **Tracker.** GitHub Issues in `all-the-rest/openchat` are the only task list.
  Commits link `Refs #N` or `Closes #N`.
- **Stack.** pnpm workspaces; React + Vite + TypeScript; Tailwind CSS 4 +
  daisyUI 5 over the `docs/spec/08-design-tokens.md` tokens; Node + Hono BFF,
  same origin; OpenCode V2 via `@opencode/client`; Vitest + Playwright, every
  change ships tests.
- **Gates.** Before commit: `pnpm run gates:fast` (lint, typecheck, test, build,
  `ratchet check --tier fast`). Build agents do not commit or push; the
  orchestrator commits and reviews dependency and script changes.
- **CodeGraph.** With `.codegraph/` present, prefer `codegraph explore` over
  grep for architecture questions.

## Security

- No secrets in the repo, the client or logs. Never expose OpenCode publicly;
  reach it only through the BFF or an internal network.
- Agent-generated HTML and artifacts run only in a sandboxed iframe on a
  separate origin. Permissions and tool approvals are security boundaries, not
  UI decoration.
