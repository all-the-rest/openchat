# 36 — Accessibility and mobile polish

**Status:** 2026-11-19. Implements issue #8 (second slice), part of milestone
2.5. It follows the dependency-free export work of the first slice (see
[`chat/export.ts`](../../apps/web/src/chat/export.ts) and
[`implementation/`](./) index) and the accessibility targets in
[`spec/09-accessibility.md`](../spec/09-accessibility.md). The builder is coding
this slice in parallel; this page records the contract and only the locally
provable parts of it.

This slice is deliberately **dependency-free**: it adds no package, no service
and no new runtime boundary. It is markup, CSS, keyboard handlers and tests on
the existing Vitest/Playwright harness. That constraint is what keeps it inside
the clean-room and build-agent lane — a dependency change (notably `axe-core`)
needs owner/orchestrator review and is explicitly *not* part of this slice (see
[Open gates](#open-gates-not-closed-by-this-slice)). All user-visible strings
go through i18n (`en`, `de`); no hard-coded UI text is introduced.

## Focus order and semantics

- **Skip link** is the first tab stop in `AppShell`: it is the first focusable
  element in the DOM, becomes visible on focus and jumps to the main landmark.
  It is not hidden with `display: none`, which would remove it from the tab
  order.
- **Drawer focus restore is guarded on viewport width.** Only an overlay drawer
  (narrow viewport) restores focus to its toggle on close. On a wide viewport,
  where the drawer is permanently visible rather than a modal overlay, the
  restore is skipped so focus is never yanked back to the toggle on an ordinary
  close.
- **`PermissionCard` uses `role="alertdialog"`** with a focus-in/focus-restore
  pair: when a permission decision appears, focus moves onto the dialog
  container (the next Tab reaches the first decision button), and after
  allow-once/always/deny it returns to the previously focused control once the
  request has settled and the composer has re-enabled. This matches the
  semantics rule in spec 09 and avoids a keyboard trap. The card has no
  `Escape`-to-cancel handler; denial is an explicit button choice.

## Keyboard map

The map extends the shortcuts already shipped; it does not replace them:

- `Ctrl/Cmd+K` — command palette (existing).
- `Ctrl/Cmd+Shift+M` — Chat/Code surface switch (existing).
- `Escape` — close the active overlay and stop editing; overlays restore focus
  to their trigger.
- `Shift+N` — new chat.
- `Ctrl/Cmd+/` — shortcuts help. Its dialog owns focus (Tab is contained),
  closes on Escape/backdrop/close and restores focus to the opener; all labels
  are i18n (`en`, `de`).

No keyboard trap is introduced. Only the shortcuts above are asserted; the
optional `ArrowUp`-on-empty-composer edit shortcut from spec 09 remains out of
scope for this slice.

## Mobile layout

- **Two-row composer below the `sm` breakpoint.** On narrow viewports the
  composer wraps onto two rows; on coarse pointers its controls use 44×44 px
  touch targets (the spec 09 minimum). The layout never relies on hover.
- **Chat header overflow on narrow screens.** Below `sm` the secondary header
  controls (meter, usage panel, completion pickers) collapse into a labelled
  overflow group behind an icon button; the title stays a visible `h1` heading
  (its text is its accessible name) and the header keeps its landmark structure.
  The overflow panel itself scrolls horizontally as a safeguard when pickers are
  populated. The E2E measures no horizontal page overflow at 390 px; 320 px is
  the design target for the layout, not an asserted viewport.
- **`contentinfo` landmark, if added.** If the builder adds the footer
  landmark, it is present once, named where needed and does not duplicate the
  `main`/`banner`/`navigation`/`complementary` landmarks. Its presence is
  conditional on the parallel work; it is not asserted unconditionally.

## Reduced motion

A global `prefers-reduced-motion` guard lives in `styles.css`: when the user
prefers reduced motion, CSS transitions/animations and smooth scrolling are
disabled (or reduced to an instant state) for the whole app rather than patched
per component. Streaming text and the thinking status are announced once, not
per token, per spec 09. One E2E case exercises this with Playwright's
`reducedMotion: "reduce"` context option at a 390×844 viewport, so the guard is
checked on a real mobile-sized render rather than only in unit tests.

## Export corner cases

The first-slice Markdown exporter is hardened for transcript text that could
otherwise become document structure or produce a hostile filename:

- **Thematic breaks and pipes and HTML are escaped** in addition to the
  existing backslash/heading/quote/list/code-fence escaping: a line made only
  of `-`, `*` or `_` markers cannot become a horizontal rule, every `|` that
  would break a table cell is escaped, and a leading `<` (which would open a
  raw-HTML block) is written as `&lt;`.
- **An `ErrorPart` line is exported.** Error parts get their own detail line
  alongside the existing tool and artifact detail lines; the label is reused
  from the tool-status vocabulary, so no new UI string is introduced, and only
  the short `message` is exported — codes, retry flags and tool bodies stay in
  the chat.
- **CJK/emoji slug fallback.** Titles that reduce to no usable ASCII after
  folding and NFKD normalization (for example, all CJK or emoji) fall back to
  the stable `chat.md` name instead of producing an empty or
  filesystem-hostile filename. The 60-character cap is applied by code point
  so surrogate pairs are never split.
- **Long-message stability.** Very long messages are exported in full without
  mid-content truncation or loss of the surrounding sections; the work stays
  linear in input size and the export remains deterministic byte-for-byte.

## Open gates (not closed by this slice)

These are called out explicitly so the slice is not mistaken for a full
accessibility sign-off:

- **(a) No axe scans, no new dependency.** `axe-core` is not added and no
  axe scan (Vitest or Playwright) is introduced. A dependency change needs
  owner/orchestrator review, and [`spec/09`](../spec/09-accessibility.md)
  line 72 (axe checks in Vitest/Playwright) and
  [`spec/10`](../spec/10-acceptance.md) line 165 (no serious axe findings) still
  require it. They remain open requirements.
- **(b) OBS-038 stays open.** The M0 accessibility probe — keyboard, focus,
  screen readers and reduced motion, with E2 snapshots — is still recorded as
  `open` in [`clean-room/01-observation-log.md`](../clean-room/01-observation-log.md).
  Under the clean-room role rules it may only be closed by an **observer**
  session; a builder or documentation closure cannot close it.
- **(c) No WCAG 2.2 AA claim.** Because (a) and (b) are outstanding, the M6 exit
  criterion "WCAG 2.2 AA pass with no serious axe findings" is **not claimed as
  met** by this slice. Only the locally provable parts — focus order, keyboard
  reachability, mobile touch targets, reduced-motion guard and export
  correctness — are asserted here. A screen-reader spot check (VoiceOver) and
  the axe findings are separate gates.

## Tests

- **`apps/web/test/a11y-focus.test.tsx`** — skip link is the first tab stop;
  opening the palette over a menu and pressing Escape settles focus on exactly
  one element; `PermissionCard` is an `alertdialog` that moves focus in on show
  and restores it after a decision (with a simulated blur-to-`body` so the
  focus tracker is exercised); the shortcuts-help overlay opens on `Ctrl/Cmd+/`,
  contains Tab, and restores focus to its opener on `Escape`; `Shift+N` starts a
  new chat (ignored while typing).
- **`apps/web/test/mobile-flow.test.tsx`** — below `sm` the composer uses two
  rows and 44×44 px controls on coarse pointers, while desktop keeps one row;
  the narrow chat-header overflow panel is reachable and its controls
  clickable. Layout/overflow itself is measured in the E2E below, not here.
- **`apps/web/e2e/mobile-reduced-motion.spec.ts`** — one Playwright case with a
  `reducedMotion: "reduce"` context at 390×844 verifies the global
  `prefers-reduced-motion` guard (near-zero computed animation/transition
  durations) and that the core chat flow opens with no horizontal overflow at
  that width. Pointer clicks drive the flow; a full keyboard-only E2E remains a
  separate gate.
- **`apps/web/test/export.test.ts`** (extended) — escaping of thematic breaks,
  pipes and raw HTML; the `ErrorPart` detail line with its i18n label; CJK/emoji
  titles falling back to `chat.md`; and byte-stable output for long messages.

Gates before any commit: `pnpm run gates:fast` (lint, typecheck, test, build,
`ratchet check --tier fast`).
