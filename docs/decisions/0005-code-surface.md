# ADR 0005 — Embed the Original OpenCode Web UI

**Status:** accepted for **V2** (2026-11-17)
**Deciders:** owner, orchestrator

## Context

The owner wants one front door: chat on one side, the original OpenCode
workspace UI on the other, switchable in the top-left, running against a remote
OpenCode host. Earlier decisions kept OpenCode's UI out of the product and
exposed only a narrow config proxy.

## Decision

1. Add a **Chat | Code** surface switch.
2. The Code surface embeds OpenCode's own web UI from a dedicated authenticated
   origin (`code.example.com`), not a rebuilt copy.
3. Authenticate with a short-lived single-use ticket exchanged for a host-only
   cookie; the browser never sees the OpenCode Basic credential.
4. Keep the artifact origin separate and cookie-free.
5. `ADMIN_PROXY` is subsumed by the Code surface; keep the narrow config-only
   route only as a fallback for deployments that refuse a second hostname.
6. If embedding is not feasible, V2 builds its own Code surface rather than
   dropping the switch. The switch itself is a firm requirement; the
   implementation is not.

## Version

V1 is chat-only and does not ship the switch. V2 adds the Code surface and the
multi-source search. Recording the decision now keeps v1 from growing.

## Rationale

- Upstream's UI is maintained and matches the pinned server; rebuilding it is
  duplicate work with a permanent upgrade tax.
- A dedicated origin avoids rewriting absolute asset and API paths.
- The ticket flow avoids shared cookies and keeps the artifact origin isolated.
- One front door matches how the owner wants to work remotely.

## Consequences

- A second hostname and an auth proxy to deploy and test.
- The Code surface is an admin-level surface: it can run shell commands. Its
  auth must be at least as strong as the app's.
- Version coupling: the embedded UI must match the pinned OpenCode server.
- The clean-room rule still applies: we embed OpenCode, never the reference
  product.

## Revisit criteria

- OpenCode adds a supported base path or an embedding API.
- A single-hostname requirement makes the ticket flow impractical.
- The owner no longer wants the Code surface in the product.
