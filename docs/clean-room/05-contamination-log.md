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

## Rules for new entries

Record:

- date and author/agent,
- what was seen (file, URL, screenshot),
- whether code or assets were involved,
- the affected specification sections,
- the countermeasure (delete, re-derive, restart builder session).

A contamination entry does not automatically invalidate the work; it makes the
risk visible and forces a decision.
