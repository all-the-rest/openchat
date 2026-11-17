# OpenChat

A clean-room rebuild of a ChatGPT-like chat interface powered by a
self-hosted [OpenCode](https://opencode.ai) backend.

**Status:** analysis phase. There is no production code yet. The first desktop
and mobile observation pass is recorded in
[`docs/clean-room/01-observation-log.md`](docs/clean-room/01-observation-log.md);
the remaining surfaces are still open.

## Goal

A single-user chat interface that feels like a modern assistant UI while
keeping all data, models, tools and agents local or self-hosted:

- chat with streaming, reasoning, tool calls and cancellation
- Markdown, code, tables, formulas, diagrams and artifacts
- file and image attachments, image generation
- agents, planning, todos, subagents and background tasks
- browser, file and MCP tools
- password-protected single-user operation; OpenCode is authenticated and never
  public
- UI i18n with English and German
- a fake backend and fake model so tests and UI work never spend provider quota

V2 (specified, not v1): dictation, interactive artifacts, a **Chat | Code**
switch that embeds the original OpenCode web UI (or our own equivalent), and
multi-source/app search.

## Architecture in three sentences

The browser talks only to a small web app (BFF) that handles authentication,
same-origin proxying and UI delivery. The BFF talks to an internal OpenCode
server through `@opencode/client`; later, `@opencode/sdk` can embed OpenCode
directly in the BFF. OpenCode owns sessions, models, agents, tools, permissions
and MCP — the UI is the shell around it.

See [`docs/architecture/01-system.md`](docs/architecture/01-system.md).

## Documents

| Area | Entry point |
| --- | --- |
| Clean-room method | [`docs/clean-room/00-method.md`](docs/clean-room/00-method.md) |
| Observation log | [`docs/clean-room/01-observation-log.md`](docs/clean-room/01-observation-log.md) |
| Surface inventory | [`docs/clean-room/02-surface-inventory.md`](docs/clean-room/02-surface-inventory.md) |
| Rendering matrix | [`docs/clean-room/03-rendering-matrix.md`](docs/clean-room/03-rendering-matrix.md) |
| Specification (filter) | [`docs/spec/README.md`](docs/spec/README.md) |
| Feasibility | [`docs/matrix/01-feasibility.md`](docs/matrix/01-feasibility.md) |
| OpenCode integration | [`docs/architecture/02-opencode-integration.md`](docs/architecture/02-opencode-integration.md) |
| Auth & deployment | [`docs/architecture/03-auth-deployment.md`](docs/architecture/03-auth-deployment.md) |
| Artifact sandbox | [`docs/architecture/04-artifact-sandbox.md`](docs/architecture/04-artifact-sandbox.md) |
| Testing & fake backend | [`docs/architecture/05-testing.md`](docs/architecture/05-testing.md) |
| Code surface (V2) | [`docs/architecture/06-code-surface.md`](docs/architecture/06-code-surface.md) |
| Roadmap | [`docs/roadmap.md`](docs/roadmap.md) |

## Boundaries

This project is not a fork, extract or redistribution of OpenAI code, assets or
prompts. Only observable behavior and interactions of the web surface are
studied and reimplemented in original code. Product name, logo and visual
identity are independent; "ChatGPT" and "OpenAI" are not used as product names
or trademarks.

Details: [`docs/clean-room/00-method.md`](docs/clean-room/00-method.md).

## Tooling for the analysis phase

REA (Reverse Engineer Anything) and the browse extension are optional local
tools for the observer. Neither is required to build or run the app, and neither
is vendored in this repository.

- **REA** — MCP server from the MIT-licensed
  [`rea-agents`](https://www.npmjs.com/package/rea-agents) package. It requires
  Node.js ≥ 26.12.1, so pin a compatible interpreter:

  ```bash
  npm install --prefix ~/.local/share/rea-mcp rea-agents@6.9.0
  # then register the MCP server in your user-level OpenCode config:
  #   "command": ["<node-bin>", "~/.local/share/rea-mcp/node_modules/rea-agents/scripts/rea.mjs", "mcp"]
  ```

- **browse** — OpenCode browser MCP used to observe the reference UI with the
  owner's own account. Cookies and session data never leave the browser.

Project configuration in `opencode.json` therefore contains no machine-specific
paths; local MCP servers live in the user-level config.

## Development

```bash
pnpm install
pnpm run dev        # BFF on :8787, web on :5173
```

Requirements: Node ≥ 24, pnpm ≥ 10, OpenCode ≥ 2.3, optionally Docker for
deployment.

## License

To be decided. All rights reserved until then.
