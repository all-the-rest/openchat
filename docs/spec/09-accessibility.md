# 09 — Accessibility

Target: WCAG 2.2 AA.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | move focus |
| `Enter` | send (in composer) |
| `Shift+Enter` | newline |
| `Escape` | close overlay; stop editing |
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+Shift+O` | new chat |
| `Ctrl/Cmd+/` | shortcuts help |
| `ArrowUp` on empty composer | edit last user message (optional) |

No keyboard trap. Overlays restore focus to the trigger.

## Focus

- Visible focus ring on every interactive element, 2 px, `color-focus`, offset
  2 px.
- Never remove focus outlines without a replacement.
- The message thread is navigable with a screen-reader-friendly landmark.
- New messages are announced politely, not on every token.

## Semantics

- Landmarks: `banner`, `navigation`, `main`, `complementary`, `contentinfo`.
- The reference labels message groups with visually hidden level-4 headings
  ("You said", "Latest answer") (OBS-015); mirror that pattern.
- Message list: `role="log"` with `aria-live="polite"` for completed messages.
- Streaming text uses a separate live region with throttled announcements.
  The reference exposes a thinking status while waiting (OBS-015); announce it
  once, not per token.
- Buttons have names; icon-only buttons have `aria-label`.
- Tool cards use `aria-expanded` for the details.
- Permission cards use `role="alertdialog"` and return focus after a decision.

## Forms

- Every input has a label.
- Errors are linked with `aria-describedby`.
- Required fields are marked in text, not only by color.
- The login form supports password managers.

## Motion

- Honor `prefers-reduced-motion`.
- No flashing content.
- Streaming cursor is subtle; no continuous bouncing animations.
- Auto-scroll can be paused by scrolling up.

## Contrast and size

- Body text ≥ 4.5:1.
- Large text and UI borders ≥ 3:1.
- Touch targets ≥ 44×44 px on mobile.
- Text can be zoomed to 200 % without loss of function.

## Internationalization

- All strings externalized (`en`, `de`).
- No concatenated sentences; use ICU messages with placeholders.
- Layout tolerates 30 % longer German strings.
- Dates, numbers and relative times use `Intl`.
- `lang` attribute follows the selected language.

## Testing

- Axe checks in Vitest/Playwright.
- Keyboard-only pass for the core flow: login → new chat → send → approve
  permission → stop → reload.
- Screen-reader spot check (VoiceOver on macOS).
- Reduced-motion screenshot pass.
