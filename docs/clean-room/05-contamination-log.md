# 05 — Contamination Log

Every encounter with reference code or assets that could influence the
implementation.

## Entries

### C-001 — Public HTTP headers and CSP

- **Date:** 2026-11-17
- **Kind:** public metadata
- **Scope:** `curl -sI https://chatgpt.com`; CSP, server headers, content type.
- **Risk:** low. No code, no assets, no UI copy.
- **Countermeasure:** only used to form hypotheses (OBS-001–004); not treated
  as a specification.

### C-002 — General model knowledge

- **Date:** 2026-11-17
- **Kind:** prior knowledge
- **Scope:** the agent knows common ChatGPT UI patterns from training data.
- **Risk:** medium. Knowledge may be outdated or wrong and is not evidence.
- **Countermeasure:** every such claim is marked E0/hypothesis and must be
  verified before it becomes a requirement.

### C-003 — REA documentation and skill

- **Date:** 2026-11-17
- **Kind:** third-party tooling
- **Scope:** REA README, installation docs, bundled skill.
- **Risk:** none for the reference; REA is MIT-licensed tooling, not the target.
- **Countermeasure:** none.

### C-004 — Authenticated observation session (desktop, dark, mobile)

- **Date:** 2026-11-17
- **Kind:** live UI inspection with the owner's own account
- **Scope:** accessibility snapshots, `getComputedStyle` measurements, bounding
  boxes, screenshots (kept in `references/raw/` only), a synthetic prompt with
  Markdown/code/math/Mermaid, the model picker, the session title menu, the
  delete confirmation and a 390 px viewport.
- **Risk:** medium. The DOM class names and CSS structure were visible in the
  inspector, even though only measurements were written down. A builder working
  in the same session could have seen them.
- **Countermeasure:** the observation was recorded as numeric facts and
  behaviour only (`OBS-010` … `OBS-030`); no markup, class name, stylesheet or
  asset was copied into the repository. The builder runs in a separate session
  without access to `docs/clean-room/**`. Screenshots are not committed.
- **Affected sections:** design tokens, surface inventory, rendering matrix,
  spec 02/03/04/05/08/09.

### C-005 — Owner's production Caddyfile

- **Date:** 2026-11-17
- **Kind:** owner-provided deployment configuration
- **Scope:** the owner's personal Caddyfile (outside this repository) — Caddy
  sites with `forward_auth`, Basic headers and health checks.
- **Risk:** none for the reference product. It is the owner's own infrastructure,
  not the reference UI.
- **Countermeasure:** only the authentication topology is used, described in
  [`docs/architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md);
  no site names, credentials or hostnames are copied into the repository.

## Rules for new entries

Record:

- date and author/agent,
- what was seen (file, URL, screenshot),
- whether code or assets were involved,
- the affected specification sections,
- the countermeasure (delete, re-derive, restart builder session).

A contamination entry does not automatically invalidate the work; it makes the
risk visible and forces a decision.
