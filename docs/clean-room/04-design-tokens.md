# 04 — Design Tokens

Measured from the reference UI on 2026-11-17 (desktop 1281 × 1143, DPR 1, light
theme). Evidence IDs in [`01-observation-log.md`](01-observation-log.md).
Values are facts; the implementation uses its own semantic token set.

## Measurement method

1. Element and state (default, hover, focus, active, disabled).
2. Viewport, zoom and DPR.
3. Computed value from `getComputedStyle` or a measured bounding box.
4. Evidence ID.

Raw captures and screenshots live in `references/raw/` and are never committed.

## Typography

| Token | Measured value | Context | Evidence |
| --- | --- | --- | --- |
| Family (sans) | computed stack resolves to the system UI sans-serif stack | body, headings, UI | OBS-012, OBS-016; a custom webfont is referenced in the CSP but its use on this surface is unverified (OBS-004) |
| Family (mono) | system monospace stack | code | OBS-016 |
| Body | 16 px / 26 px, weight 400 | assistant and user text | OBS-016 |
| Page title (H1) | 24 px / 28.8 px (1.2), weight 400 | landing heading | OBS-012 |
| Section heading (H2) | 18 px / 28 px, weight 600 | answer headings | OBS-016 |
| UI label | 14 px / 20 px, weight 400–500 | sidebar rows, tabs | OBS-011, OBS-013 |
| Section label | 14 px / 18 px, weight 500 | sidebar groups | OBS-011 |
| Table cell | 14 px / 20 px | tables | OBS-016 |
| Code | 12 px / 20 px | fenced code | OBS-016 |
| Math (inline) | ~19.4 px serif math font | KaTeX inline | OBS-016 |
| Color (primary text) | `#0d0d0d` | body, headings | OBS-010, OBS-016 |
| Color (muted) | `#8f8f8f` | placeholders, section labels, meta | OBS-011, OBS-012 |

## Surfaces and color

| Token | Measured value | Context | Evidence |
| --- | --- | --- | --- |
| App background | `#fcfcfc` | page, sidebar, main | OBS-010 |
| Elevated surface | `#ffffff` | composer, popover, active tab | OBS-012, OBS-013 |
| Selected row | `rgba(0,0,0,0.05)` | "New chat", active history item | OBS-011 |
| User bubble background | `#def3e5` | user message | OBS-016 |
| User bubble text | `#14361a` | user message | OBS-016 |
| Accent (voice / send) | `#53b559` | circular action button | OBS-012 |
| Inactive tab text | `#5d5d5d` | segmented control | OBS-013 |
| Divider | ~1 px, low-contrast neutral | sidebar/content boundary, table rows | OBS-010, OBS-016 |

Dark theme: **not measured** (OBS-027). Do not infer values.

Dark theme (OBS-027):

| Token | Dark value |
| --- | --- |
| `color-bg-app` | `#000000` |
| `color-bg-sidebar` | `#000000` |
| `color-bg-surface` | `#1b1b1b` (translucent, ~95 %) |
| `color-bg-code` | `#303030` |
| `color-text-primary` | `#ededed` |
| `color-text-muted` | `#afafaf` |
| `color-bubble-user` | `#2c6732` |
| `color-bubble-user-text` | `#effaf3` |
| `color-border-subtle` | light overlay on black |

Contrast: `#0d0d0d` on `#fcfcfc` and `#14361a` on `#def3e5` pass WCAG AA for
body text. Muted `#8f8f8f` on `#fcfcfc` is below 4.5:1 and must only be used for
non-essential text or be darkened in our implementation.

## Layout

| Token | Measured value | Context | Evidence |
| --- | --- | --- | --- |
| Sidebar width | 340 px | desktop | OBS-010 |
| Header height | 52 px | content header | OBS-010 |
| Content column | 941 px at 1281 px viewport | main | OBS-010 |
| Thread width | 768 px | messages and composer | OBS-012, OBS-016 |
| Assistant text width | 736 px (16 px inset) | answer body | OBS-016 |
| Composer | 768 × 52 px | landing and thread | OBS-012 |
| Composer min height | 52 px | single line | OBS-012 |
| Suggestion chip | 768 × 52 px | landing | OBS-012 |
| Sidebar row | 328 × 35 px at x 6 | primary actions, history | OBS-011 |
| Segmented control | 224 × 36 px | header center | OBS-013 |
| Mode segment | 112 × 36 px | Chat / Work (reference only, not implemented) | OBS-013 |
| Icon button | 36 × 36 px | plus, mic, voice, scroll | OBS-012, OBS-017 |
| Popover | right-aligned to composer, above it | model picker | OBS-014 |

Mobile (390 px, OBS-028):

| Token | Measured value |
| --- | --- |
| Header | 52 px |
| Header title button | 180 × 36 px, 15 px / 20 px, radius 8 |
| Thread inset | 16 px |
| User bubble max width | 70 % of the thread column |
| Composer width | viewport − 32 px |
| Composer form height | 87 px (two rows) |
| Composer radius | ~28 px |
| Scroll-to-bottom button | 36 px circle, centered above the composer |

Tablet and desktop breakpoints (OBS-035):

| Token | Measured value |
| --- | --- |
| Sidebar visible | ≥ 768 px |
| Sidebar hidden | < 768 px |
| Composer single row | ≥ 640 px |
| Composer two rows | < 640 px |
| Content inset | ~32 px at 640–1023 px, 16 px below 640 px |
| Thread max width | 768 px |

## Add menu

| Token | Measured value | Context | Evidence |
| --- | --- | --- | --- |
| Panel | 768 px wide, max 378 px high | above the composer | OBS-036 |
| Panel radius | 20 px | | OBS-036 |
| Panel padding | 8 px | | OBS-036 |
| Panel border | 1 px `rgba(0,0,0,0.1)` | light theme | OBS-036 |
| Row | 739 × 36 px, radius 12, padding 6 × 8 | | OBS-036 |
| Row label / description | 14 px / muted | | OBS-036 |
| Scroll area | 360 px high inside the panel | | OBS-036 |

Spacing: 6 px sidebar gutter, 16 px section inset, 8 px composer inner gap,
22 px heading-to-composer gap, 24 px composer-to-suggestion gap, 8 px table cell
padding, 10 × 16 px bubble padding.

## Radius

| Token | Measured value | Context | Evidence |
| --- | --- | --- | --- |
| Row | 8 px | sidebar rows | OBS-011 |
| Chip / card | 16 px | suggestion chip, diagram block | OBS-012, OBS-016 |
| Bubble | 22 px | user message | OBS-016 |
| Composer | 26 px | composer shell | OBS-012 |
| Pill | 9999 px | buttons, segmented control | OBS-012, OBS-013 |

## Shadow

| Token | Measured value | Context | Evidence |
| --- | --- | --- | --- |
| Composer | `0 0 0 1px rgba(0,0,0,.04)`, `0 2px 8px rgba(0,0,0,.04)`, `0 4px 80px 8px rgba(0,0,0,.024)` | composer shell | OBS-012 |
| Popover | soft, low-opacity, large blur | model picker | OBS-014 |

## Motion

Not measured yet. Record durations and easing for: streaming indicator,
popover open/close, sidebar section collapse, message insertion, scroll
affordance. No values before measurement.

## Open

- Dark theme surfaces and text colors (OBS-027).
- Hover, focus, active and disabled states per component.
- Focus ring color and width.
- Breakpoints and the collapsed sidebar width (OBS-028).
- Right rail / artifact panel width (OBS-020).
- Reduced-motion behavior.
