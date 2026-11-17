# ADR 0002 — Auth and Deployment

**Status:** accepted (2026-11-17)
**Deciders:** owner, orchestrator

## Context

The app controls an agent with shell access. A single password is acceptable for
the prototype, but the security model must not pretend to be multi-user.

## Options

1. **Edge Basic Auth only** (Caddy), BFF trusts the edge.
2. **BFF session login only**, Caddy provides TLS.
3. **Both**: optional edge Basic Auth plus BFF session.

## Decision

Support `AUTH_MODE=basic` for the first prototype and `AUTH_MODE=session` as the
recommended mode. Keep Caddy Basic Auth as an optional second layer. Never
publish OpenCode.

## Rationale

- Basic Auth is the smallest possible gate and matches the "prototype only"
  requirement.
- A session cookie gives logout, TTL, rate limiting and a better UX without much
  code.
- Two layers cost little and protect against a misconfigured BFF.
- Single-user means no roles, no invitations, no password reset flow.

## Consequences

- The BFF must be unreachable except through Caddy.
- The session secret and password hash are deployment secrets.
- Switching modes must not change the data model.
- Multi-user would require a redesign; documented as out of scope.
