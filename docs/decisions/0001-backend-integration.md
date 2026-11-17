# ADR 0001 — Backend Integration

**Status:** accepted (2026-11-17)
**Deciders:** owner, orchestrator

## Context

The UI needs sessions, streaming, agents, tools, permissions, MCP, artifacts and
model configuration. OpenCode already provides all of it in V2. We must choose
how the web app talks to it.

## Options

1. **BFF + `opencode serve` + `@opencode/client`** — separate process, HTTP/SSE
   over a private network, BFF handles auth and same-origin proxying.
2. **Embedded `@opencode/sdk`** — OpenCode runs inside the Bun BFF, no listener.
3. **Fork the official OpenCode web UI** — extend upstream.
4. **Static client** — browser talks directly to OpenCode.

## Decision

Use **option 1** for v1. Keep the backend behind a `ChatBackend` port and add an
**option 2** adapter as an experimental mode once the first chat works.

## Rationale

- Option 1 keeps the official OpenCode web UI available *behind the admin
  proxy* for provider, OAuth and MCP configuration. That is exactly the part we
  do not want to rebuild, and the product UI never links to it unless
  `ADMIN_PROXY=on`.
- Process isolation limits the blast radius of an OpenCode crash and makes
  upgrades a container swap.
- Same-origin proxying removes CORS and hides the internal port.
- `@opencode/client` is generated from the same contract as the API and supports
  streaming.
- Option 2 is attractive for a single-process deployment and custom plugins, but
  the SDK is newer and gives up the official UI. It is a spike, not the default.
- Option 3 would fight upstream and make a ChatGPT-like UX harder.
- Option 4 cannot provide safe auth, same-origin artifacts or secret isolation.

## Consequences

- Two processes to deploy and monitor.
- A localhost/private-network hop for every call.
- The BFF must proxy SSE correctly (no buffering, long timeouts).
- The adapter must be thin so an OpenCode API change is contained.
- Revisit when the SDK is stable and the official UI is no longer needed.

## Revisit criteria

- The localhost hop measurably hurts latency.
- Single-process deployment becomes a hard requirement.
- The SDK supports the same feature set and lifecycle guarantees.
