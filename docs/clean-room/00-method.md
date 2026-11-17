# 00 — Clean-Room Method

**Status:** binding as of 2026-11-17.

## Purpose

The reference UI (ChatGPT web) is to be understood functionally and rebuilt
with original code. "Clean room" here means observation and implementation are
separated. Observation produces facts and a specification; implementation sees
only the specification, not the reference.

This prevents accidental code and asset copying and makes decisions auditable.

## Legal and ethical frame

Allowed:

- Operate the reference with your own account and your own data.
- Observe publicly delivered surfaces, interactions and response shapes.
- Document layout measurements, colors, state transitions and information
  architecture as facts.
- Read public documentation and public metadata.

Not allowed:

- Copy or redistribute source code, bundles, CSS, HTML fragments, icons, fonts,
  logos or text.
- Bypass authentication, paywalls, rate limits or DRM.
- Access other accounts, chats or personal data.
- Extract internal prompts, model weights or non-public APIs.
- Create the impression that the product is ChatGPT or made by OpenAI.

Publication requires a separate trademark, competition and copyright review.
This document is not legal advice.

## Roles and Chinese wall

| Role | Task | Sees reference | Writes |
| --- | --- | --- | --- |
| Observer | operate, measure, record | yes | `docs/reference/**`, `docs/clean-room/01-*` … `05-*`, `docs/spec/**` |
| Builder | implement | **no** | `apps/**`, `packages/**`, `features/**`, tests, root build config, `docs/architecture/**` with an ADR |
| Reviewer | verify | only for acceptance | review notes in the issue |

The separation is enforced in OpenCode:

- `.opencode/agents/observer.md` cannot write production code.
- `.opencode/agents/builder.md` cannot read `docs/reference/**`, `docs/clean-room/**`
  or `references/**`, and cannot use Code Mode. Because V2 resolves permissions
  last-match-wins, the builder file lists broad allows first and every
  restriction last; denying `execute` alone is not enough, so the `browse_*` and
  `rea_*` MCP tools are denied by name as well.
- The canonical role table lives in `AGENTS.md`; this document only explains the
  method.

Residual risk: a single model can ignore rules if they are in its context.
Therefore use separate sessions and never put reference material into the
builder context. Strict separation would require separate accounts or
containers.

## Evidence model

Every statement gets an ID and a level:

| Level | Meaning | Example |
| --- | --- | --- |
| E0 | assumption, unverified | "there is probably X" |
| E1 | screenshot | visible state |
| E2 | DOM/accessibility snapshot | roles, labels, structure |
| E3 | interaction log | before/after, click path |
| E4 | network/header observation | CSP, requests, events |
| E5 | reproduced | two independent runs |

Rules:

- A specification requirement needs at least E2 or E3.
- E0 may appear in the log but never as a requirement.
- "Not observable" is a valid result and is recorded as `open` with a reason.

## Flow

1. **Observe** — operate the UI, capture screenshots, snapshots, network.
2. **Record** — evidence ID, level, date, reproduction in
   `01-observation-log.md`.
3. **Distill** — derive patterns and rules in `docs/spec/**`; no raw data.
4. **Implement** — the builder reads only the specification.
5. **Verify** — the reviewer checks against the specification and acceptance
   criteria; optional visual comparison, but no code copying.

## What may go into the specification?

Allowed:

- Functional descriptions, states, transitions, edge cases.
- Information architecture and navigation paths.
- Layout measurements, spacing, radii, type scale, colors, shadows, motion.
- Response shapes: Markdown, tables, code, formulas, diagrams, artifacts.
- Interaction details: focus, hover, loading, empty and error states.
- Accessibility requirements.

Not allowed:

- Copied HTML/CSS/JS code or class names from the reference.
- Assets, icons, fonts, logos, images.
- Verbatim UI copy at a relevant scale.
- Screenshots as production assets.
- Internal prompt or model information.

## Privacy and redaction

- `references/raw/` is gitignored and holds raw material.
- Screenshots are redacted before commit: no chat titles, messages, email
  addresses or tokens.
- Network captures are not committed. Cookies and authorization headers are
  never documented.
- Test data is synthetic.

## Contamination

Contamination is any encounter with reference code or assets that could
influence the implementation. It is recorded in `05-contamination-log.md` with
date, kind, scope and countermeasure.

Examples:

- A bundle is opened by accident.
- A screenshot contains readable source code.
- An asset is copied into the working tree.

Countermeasures: delete the file, restart the builder session, re-derive the
affected specification sections from observation.

## Definition of done for the analysis

- Surface inventory complete for desktop and mobile.
- Rendering matrix for all candidates with status and evidence.
- Design tokens measured, not guessed.
- Chat lifecycle including error and cancellation states described.
- Agent, task and planning flows described.
- Open questions listed explicitly.
- No reference assets in the repository.
