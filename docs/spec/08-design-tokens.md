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

Contrast: text on its background must reach WCAG AA (4.5:1 for body, 3:1 for
large text and UI borders).

## Typography

| Token | Value |
| --- | --- |
| `font-sans` | `Inter, system-ui, -apple-system, "Segoe UI", sans-serif` |
| `font-mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` |
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
| `radius-sm` | 6 px |
| `radius-md` | 10 px |
| `radius-lg` | 14 px |
| `radius-xl` | 20 px |
| `radius-full` | 9999 px |

Messages use `radius-lg`; inputs and buttons `radius-md`; chips `radius-full`.

## Layout

| Token | Value |
| --- | --- |
| `sidebar-width` | 260 px |
| `sidebar-collapsed` | 64 px |
| `content-max` | 768 px |
| `composer-max` | 768 px |
| `right-rail-width` | 420 px |
| `header-height` | 56 px |
| `composer-min-height` | 52 px |
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
