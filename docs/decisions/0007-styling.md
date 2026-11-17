# ADR 0007 — Tailwind 4 and daisyUI 5 as the Styling Layer

**Status:** accepted for v1 (2026-11-17)
**Deciders:** owner, orchestrator

## Context

[`08-design-tokens.md`](../spec/08-design-tokens.md) fixes semantic tokens
(color, type, spacing, radius, layout, motion) and forbids raw hex in
components. The stack list in `AGENTS.md` names React, Vite, TypeScript,
Tailwind and daisyUI, but nothing was implemented yet, so the question was
whether daisyUI's component vocabulary helps or fights the measured design.

The UI is a single-tenant chat surface: sidebar, transcript, composer, menus,
dialogs, toasts, tool cards, artifact chrome. Most of it is bespoke; the
generic controls are the fiddly, accessibility-heavy part.

## Decision

1. **Tailwind CSS 4 is the only styling engine.** No CSS-in-JS, no per-component
   stylesheet. One global sheet imports Tailwind, daisyUI and the theme blocks.
2. **daisyUI 5 is the component layer for generic controls**: drawer, menu,
   dropdown, modal, tooltip, toast, tabs, collapse, badge, skeleton, loading,
   toggle, input/select/textarea, button, join, alert, progress, table.
3. **Chat surfaces stay ours**: message bubble and transcript, composer shell,
   tool/permission cards, code blocks, citation chips, artifact chrome, sidebar
   session rows. daisyUI's `chat` component is not the bubble — its radius,
   padding and width bands differ from the measured ones; use plain flex plus
   the bubble tokens.
4. **One daisyUI theme per app theme** (`openchat` / `openchat-dark`, the latter
   with `prefersdark`), generated from spec 08. Theme switch is
   `data-theme` on `<html>`; there are no `dark:` color variants.
5. **Tokens beyond daisyUI's 20 semantic colors go into `@theme`**
   (`--color-bubble-user`, `--color-code-bg`, `--font-mono`,
   `--radius-bubble`). daisyUI's `base-*`, `primary`, `success`, `warning`,
   `error` map onto our tokens 1:1.
6. **No raw hex or Tailwind palette utilities in components**, except charts and
   status glyphs that must be theme-independent. Review catches this until a
   lint rule exists.
7. **Pin the majors** (Tailwind 4, daisyUI 5) and upgrade in a PR with a visual
   diff. No CDN in the app; artifacts stay framework-free.
8. **Artifacts never see daisyUI.** The artifact shell exposes only plain CSS
   variables (`--bg`, `--fg`, `--muted`, `--accent`, `--radius`) so generated
   apps look native without shipping a UI library
   ([`07-artifact-runtime.md`](../architecture/07-artifact-runtime.md)).

## Cost

Measured with Tailwind 4.3.5 + daisyUI 5 and one chat-shell page using about
30 component usages (drawer, navbar, chat, card, alert, tabs, collapse, join,
select, textarea, dropdown, modal, toast, tooltip, skeleton, toggle, badge,
loading, progress, input, button):

- 85.7 KB minified, **14.1 KB gzip**, one cached asset for the whole app.
- The build emits only the components in use plus the theme variables.

Hand-rolling the same primitives would save most of that CSS but cost the
keyboard behaviour, focus handling and ARIA wiring that daisyUI already ships.

## Consequences

- M1 scaffolds `packages/ui` with the two theme blocks and a small token map.
- The measured metrics (340 px sidebar, 52 px header, 16/22/26 px radii, bubble
  colors) live as theme variables, not as utility overrides sprinkled through
  markup.
- daisyUI's defaults (`--depth`, `--noise`, small radii) are reset in the theme
  blocks, so the measured design is the default rather than an exception.
- A daisyUI major upgrade can rename classes; the pinned version and the visual
  diff contain that risk.
- One color vocabulary: components use `bg-base-200`, `text-base-content`,
  `text-error`; they never use `gray-700` or `#1b1b1b`.

## Alternatives rejected

- **Tailwind only, hand-rolled primitives** — viable, but re-implements modal,
  dropdown, drawer and toast semantics that are already solved.
- **shadcn-style copied components** — more code to own and a second styling
  convention next to tokens; daisyUI gives the same primitives as a dependency.
- **CSS Modules / vanilla-extract / styled-components** — a second styling
  system beside Tailwind, and no benefit for a single app.
- **daisyUI for the transcript and composer** — the measured chat geometry does
  not match daisyUI's `chat` component, so we would override nearly every band.
