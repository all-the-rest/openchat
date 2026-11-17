# 08 — Design Tokens

Semantic tokens for the implementation. Values are our own defaults; they are
tuned after the reference measurements in
[`docs/clean-room/04-design-tokens.md`](../clean-room/04-design-tokens.md) are
available. Do not copy a stylesheet or class names.

## Color

| Token | Default | Use |
| --- | --- | --- |
| `color-bg-app` | `#0f1115` | app background (dark) |
| `color-bg-sidebar` | `#0b0d11` | sidebar |
| `color-bg-surface` | `#161a21` | cards, messages |
| `color-bg-elevated` | `#1d222b` | popovers, menus |
| `color-bg-hover` | `#232935` | hover |
| `color-bg-selected` | `#2a3140` | selected row |
| `color-text-primary` | `#e8ecf1` | primary text |
| `color-text-secondary` | `#a7b0bd` | secondary text |
| `color-text-muted` | `#78828f` | hints, metadata |
| `color-text-inverse` | `#0b0d11` | on accent |
| `color-border-subtle` | `#252b35` | dividers |
| `color-border-strong` | `#38414f` | inputs |
| `color-accent` | `#4f8cff` | primary action, links |
| `color-accent-hover` | `#6ba0ff` | hover |
| `color-success` | `#3fb950` | done |
| `color-warning` | `#d29922` | warning |
| `color-danger` | `#f85149` | error, destructive |
| `color-focus` | `#8ab4ff` | focus ring |

Light theme mirrors the same semantic names with inverted surfaces. The accent
is intentionally independent of the reference brand.

Measured light values (OBS-010 … OBS-016) — use these for the light theme:

| Token | Light value |
| --- | --- |
| `color-bg-app` | `#fcfcfc` |
| `color-bg-sidebar` | `#fcfcfc` |
| `color-bg-surface` | `#ffffff` |
| `color-bg-hover` | `rgba(0, 0, 0, 0.05)` |
| `color-bg-selected` | `rgba(0, 0, 0, 0.05)` |
| `color-text-primary` | `#0d0d0d` |
| `color-text-secondary` | `#5d5d5d` |
| `color-text-muted` | `#8f8f8f` |
| `color-border-subtle` | `rgba(0, 0, 0, 0.08)` |
| `color-bubble-user` | `#def3e5` |
| `color-bubble-user-text` | `#14361a` |
| `color-action` | `#2f7d36` |

`#8f8f8f` on `#fcfcfc` is below 4.5:1: use it only for non-essential meta, and
use `#5d5d5d` where the text must be readable. The reference action green
(`#53b559`) is too light for white label text; darken it to `#2f7d36` for
primary buttons and keep the lighter green for icon-only accents.

Measured dark values (OBS-027):

| Token | Dark value |
| --- | --- |
| `color-bg-app` | `#000000` |
| `color-bg-sidebar` | `#000000` |
| `color-bg-surface` | `#1b1b1b` at 95 % opacity |
| `color-bg-code` | `#303030` |
| `color-text-primary` | `#ededed` |
| `color-text-secondary` | `#c9c9c9` |
| `color-text-muted` | `#afafaf` |
| `color-bubble-user` | `#2c6732` |
| `color-bubble-user-text` | `#effaf3` |
| `color-border-subtle` | `rgba(255, 255, 255, 0.12)` |

Contrast: text on its background must reach WCAG AA (4.5:1 for body, 3:1 for
large text and UI borders).

## Typography

The reference renders with the platform UI font; the measured stack is system
UI (OBS-010). Use the system stack. Bundling a webfont requires a license, a
self-hosted file and a documented reason; do not add one by default.

| Token | Value |
| --- | --- |
| `font-sans` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| `font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |
| `text-xs` | 12 px / 16 px |
| `text-sm` | 13 px / 18 px |
| `text-base` | 15 px / 24 px |
| `text-lg` | 17 px / 26 px |
| `text-xl` | 20 px / 28 px |
| `text-2xl` | 24 px / 32 px |
| `weight-regular` | 400 |
| `weight-medium` | 500 |
| `weight-semibold` | 600 |

Long-form assistant text uses `text-base` with a maximum measure of 72
characters.

## Spacing

4 px base: `space-1` 4, `space-2` 8, `space-3` 12, `space-4` 16, `space-5` 20,
`space-6` 24, `space-8` 32, `space-10` 40, `space-12` 48.

## Radius

| Token | Value |
| --- | --- |
| `radius-sm` | 8 px |
| `radius-md` | 16 px |
| `radius-lg` | 22 px |
| `radius-xl` | 26 px |
| `radius-full` | 9999 px |

Sidebar rows use `radius-sm`; chips, cards, diagram blocks and the add-menu rows
`radius-md`; user bubbles `radius-lg`; the composer shell and the add-menu panel
`radius-xl`; buttons use `radius-full`. One token per measured band — do not add
a token per component.

## Layout

| Token | Value |
| --- | --- |
| `sidebar-width` | 340 px |
| `sidebar-collapsed` | 64 px (not measured) |
| `content-max` | 768 px |
| `thread-width` | 768 px |
| `thread-text` | 736 px |
| `composer-max` | 768 px |
| `right-rail-width` | 420 px (not measured) |
| `header-height` | 52 px |
| `composer-min-height` | 52 px |
| `chip-height` | 52 px |
| `sidebar-row` | 35 px high, 8 px gutter |
| `touch-target` | 44 px |

Breakpoints: `sm` 640, `md` 768, `lg` 1024, `xl` 1280.

## Shadow

| Token | Value |
| --- | --- |
| `shadow-sm` | `0 1px 2px rgb(0 0 0 / 0.25)` |
| `shadow-md` | `0 4px 16px rgb(0 0 0 / 0.30)` |
| `shadow-lg` | `0 12px 40px rgb(0 0 0 / 0.40)` |

## Motion

| Token | Value |
| --- | --- |
| `motion-fast` | 120 ms |
| `motion-base` | 180 ms |
| `motion-slow` | 240 ms |
| `ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |

Respect `prefers-reduced-motion: reduce`: no transforms, no auto-playing
animation, instant scroll.

## Rules

- Use semantic tokens only; no raw hex values in components.
- Dark and light themes must use the same token names.
- Every token change is a spec change.
- The reference measurement may adjust values, but never at the cost of
  contrast or readability.

## Implementation

Tailwind 4 + daisyUI 5 carry these tokens (ADR-0007):

| Ours | daisyUI theme variable |
| --- | --- |
| `color-bg-app` | `--color-base-100` |
| `color-bg-surface` | `--color-base-200` |
| `color-bg-elevated` | `--color-base-300` |
| `color-text-primary` | `--color-base-content` |
| `color-text-secondary` | `--color-secondary` |
| `color-accent` | `--color-primary` / `--color-accent` |
| `color-success` / `color-warning` / `color-danger` | `--color-success` / `--color-warning` / `--color-error` |
| `radius-sm` / `radius-md` / `radius-lg` / `radius-xl` | `--radius-box` / `--radius-field` / `--radius-selector` / bubble token |
| `font-sans` / `font-mono` | `--font-sans` / `--font-mono` |

- Tokens without a daisyUI counterpart (`color-bubble-user`,
  `color-code-bg`, `composer-*`) are declared in `@theme` and used as normal
  utilities (`bg-bubble-user`).
- Theme switch is `data-theme` on `<html>`; components never use `dark:`
  variants for colors.
- daisyUI defaults that contradict the measured bands (`--depth`, `--noise`,
  small radii, shadows) are reset in both theme blocks.
