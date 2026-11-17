# 04 — Design Tokens

Measured values from the reference UI. **No values yet** — the authenticated
observation has not started. Do not guess.

## Measurement method

For each token, record:

1. The element and state (default, hover, focus, active, disabled).
2. The viewport (desktop, tablet, mobile) and zoom/DPR.
3. The computed value from the browser (`getComputedStyle`) or a measured
   bounding box.
4. The evidence ID from the observation log.

Example command in the browser context:

```js
const el = document.querySelector("…")
const s = getComputedStyle(el)
return {
  fontFamily: s.fontFamily,
  fontSize: s.fontSize,
  lineHeight: s.lineHeight,
  fontWeight: s.fontWeight,
  color: s.color,
  background: s.backgroundColor,
  padding: s.padding,
  borderRadius: s.borderRadius,
  boxShadow: s.boxShadow,
}
```

## Token table

| Token | Value | Context | Evidence | Status |
| --- | --- | --- | --- | --- |
| Font family (sans) | — | body | — | open |
| Font family (mono) | — | code | — | open |
| Type scale | — | h1–h6, body, caption | — | open |
| Line heights | — | body, headings | — | open |
| Text colors | — | primary, secondary, muted, inverse | — | open |
| Surface colors | — | app, sidebar, card, composer, hover | — | open |
| Border colors | — | subtle, strong, focus | — | open |
| Accent color | — | primary action, selection | — | open |
| Spacing scale | — | 4/8/12/16/24/32… | — | open |
| Radii | — | input, card, bubble, panel | — | open |
| Shadows | — | card, popover, modal | — | open |
| Content width | — | thread, composer | — | open |
| Sidebar width | — | expanded, collapsed | — | open |
| Composer height | — | empty, multiline, with attachments | — | open |
| Breakpoints | — | mobile, tablet, desktop | — | open |
| Motion durations | — | hover, panel, stream | — | open |
| Focus ring | — | keyboard focus | — | open |

## Rules

- Values are facts, not assets. Never copy a stylesheet or class names.
- Use the measured values to build our own token set; do not mirror the
  reference one-to-one if it conflicts with accessibility or our brand.
- Every token used in the implementation must exist in
  [`docs/spec/08-design-tokens.md`](../spec/08-design-tokens.md).
