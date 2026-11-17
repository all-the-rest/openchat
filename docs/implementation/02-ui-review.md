# UI Review — OpenChat M1/M2 — 2026-11-17

Capture: `npx playwright test -c playwright.screenshots.config.ts` (in `apps/web`) ·
output: `apps/web/ui-review/` (gitignored) · 38 capture tests (plus one seed
setup test that writes no PNG) producing 64 PNGs, four breakpoints, plus theme,
locale, drawer, tool-card and dictation-recording variants. The four viewport
projects (`mobile`, `tablet`, `desktop`, `wide`) run in parallel with four
workers; a first `seed` project creates the four fixture chats once, before any
of them starts, and writes their session IDs to
`test-results/ui-review-seeds.json`, so the sidebar is identical in every
capture.

The run also boots the same fake Whisper service the E2E suite uses
(`apps/web/e2e/fake-stt.ts`, port 8899) and points the BFF at it with `STT_URL`,
so `/api/info` advertises dictation. Chromium runs with
`--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`, and
the context grants the `microphone` permission. Consequence: the microphone
control is present in **every** authenticated capture now, which is the intended
configured state; the "no STT configured" state (control absent) is covered by
unit tests, not by a capture.

Verdict: **APPROVED** — no `critical` or `high` findings. One medium finding was
fixed during the first review round; eight findings exist, and the seven still
open (one medium, six low) are tracked in
[#27](https://github.com/all-the-rest/openchat/issues/27) and listed in
`ratchet.findings.json`.

## Coverage

The manifest (`apps/web/screenshots/ui-review.config.ts`) is the single source
of truth; each route can add `variants`, and every variant becomes its own test.
Base captures are light and English (Playwright's default
`prefers-color-scheme: light`). `theme` and `locale` are applied through
`addInitScript` before the app mounts, so the first paint already shows them; no
UI is clicked through. The drawer, tool-card and dictation variants are post-load
actions (`open-drawer`, `expand-tool`, `start-dictation`). Each test runs in a
fresh context, so variants cannot leak into each other. All four scenarios come
from one seed set: the
`seed` project (`apps/web/screenshots/seed.setup.ts`) runs once per capture run,
logs in through `POST /api/auth/login`, creates the same four chats as before
and waits for the terminal assistant status, then writes
`{ rich, tools, error, empty }` session IDs to `UI_REVIEW_SEEDS`. The viewport
projects only read that file, which is why parallel workers cannot add
duplicate titles to the sidebar; a missing or incomplete seed file fails the
run with the file path instead of capturing a wrong sidebar.

| Route | State | Viewports | Screenshots |
| --- | --- | --- | --- |
| `login` | empty | 390, 820, 1440, 1920 | `empty/<viewport>/login.png` |
| `login` | empty, dark · de | 390, 1440 | `empty/<viewport>/login-{dark,de}.png` |
| `landing` | empty | 390, 820, 1440, 1920 | `empty/<viewport>/landing.png` |
| `landing` | empty, dark · de | 390, 1440 | `empty/<viewport>/landing-{dark,de}.png` |
| `landing` | empty, drawer | 390, 820 | `empty/<viewport>/landing-drawer.png` |
| `chat-rich` | filled | 390, 820, 1440, 1920 | `filled/<viewport>/chat-rich-sec0..1.png` |
| `chat-rich` | filled, dark · de | 390, 1440 | `filled/<viewport>/chat-rich-{dark,de}-sec0..1.png` |
| `chat-tools` | filled | 390, 1440 | `filled/<viewport>/chat-tools-sec0.png` |
| `chat-tools` | filled, dark | 390, 1440 | `filled/<viewport>/chat-tools-dark-sec0.png` |
| `chat-tools` | filled, expanded | 390, 1440 | `filled/<viewport>/chat-tools-expanded-sec0.png` |
| `chat-error` | filled | 390, 1440 | `filled/<viewport>/chat-error-sec0.png` |
| `chat-empty` | empty | 390, 1440 | `empty/<viewport>/chat-empty-sec0.png` |
| `chat-empty` | empty, recording | 390, 1440 | `empty/<viewport>/chat-empty-recording-sec0.png` |

Measured totals: 38 capture tests (18 base cells + 18 variant cells + 2 recording
cells) plus the one `seed` setup test, 39 Playwright tests in total, 64 PNGs —
`empty/` 40, `filled/` 24. The setup test only writes the seed JSON, so it adds no captured
file and no test to any viewport project; it runs once, before all of them.
Scroll coverage is recorded per capture in the sibling `.json` files, which now
also carry the measured `variant`, `theme` and `locale`. The chat transcript is
the sampled inner scroller (`[data-testid="transcript"]`); at 1440 px the rich
chat needs two sections (0 and 252 px), so top and footer were both reviewed.
Login and landing are short pages with a full-page overview.

Theme and locale variants are captured at 390 and 1440 px only: tablet (820)
and wide (1920) reuse the desktop column and differ mainly in surrounding
space, so a colour or copy change there adds little signal. Add them to the
manifest if a specific tablet/wide question comes up.

What was **not** reviewed: hover/focus states beyond the password field,
permission cards (not implemented), attachments and the artifact sandbox (not
implemented in M1/M2), dark at 820/1920, `de` at 820/1920, the drawer over a
non-empty transcript, the tool card's *output* panel (the action expands the
first card's input sections only), and pixel-diff regression snapshots (the
harness produces review artifacts, not assertions). For dictation, the capture
covers the resting control and an active recording only; the permission-request
state, the transcribing spinner, the error line with Retry/Dismiss, the limit
notice and the German pill are asserted by unit and E2E tests but not captured.

## Empty · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/desktop/login.png` | Coverage: card centered at 384 px, top-right locale/theme controls, disabled submit clearly disabled. No defect. | — |
| UI-3 | low | open | orchestrator | #27 | `apps/web/src/pages/LoginPage.tsx:64` | `empty/desktop/login.png` | No product branding on the login card; the app header elsewhere shows "OpenChat". | Add a wordmark above the card. |
| UI-4 | low | open | orchestrator | #27 | `apps/web/src/pages/ChatPage.tsx:56` | `empty/desktop/chat-empty-sec0.png` | Empty chat is one muted line pinned under the header while the landing hero is centered. | Center the empty state or reuse the landing hero. |
| UI-8 | low | open | orchestrator | #27 | `apps/web/src/dictation/DictationButton.tsx:77` | `empty/desktop/landing.png` | The dictation microphone is a bare glyph in a transparent circle next to the filled send disc, so it reads as an icon rather than a control. | Give the idle mic the same surface as send, or make both ghost. |
| UI-2 | medium | fixed | orchestrator | #27 | `apps/web/src/chat/Transcript.tsx` | `filled/desktop/chat-error-sec0.png` | Error card promised a retry that did not exist. | Fixed 2026-11-17: Continue/Retry actions render under the last assistant message; regression test in `apps/web/test/transcript.test.tsx`. |

## Empty · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| UI-5 | low | open | orchestrator | #27 | `apps/web/src/chat/Composer.tsx` | `empty/mobile/landing.png`, `empty/mobile/landing-de.png` | "Enter sends, Shift+Enter adds a line" is shown on a touch viewport (German copy does the same). | Hide under `(pointer: coarse)` or swap the copy. |
| UI-7 | low | open | orchestrator | #27 | `apps/web/src/pages/LoginPage.tsx:64` | `empty/mobile/login.png`, `empty/mobile/login-dark.png`, `empty/mobile/login-de.png` | Password focus shows an outline plus border as a heavy double ring, close to an error affordance; the same ring is more prominent in dark. | Use one focus ring. |
| UI-8 | low | open | orchestrator | #27 | `apps/web/src/dictation/DictationButton.tsx:77` | `empty/mobile/landing.png` | Same bare mic next to the filled send disc; at 390 px the icon is the only hint that dictation exists. | As above. |

## Filled · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `filled/desktop/chat-rich-sec0..1.png` | Coverage: transcript at 768 px, table, math, code, mermaid, tool card and copy affordances render; sidebar 340 px. No defect. | — |
| — | — | — | — | — | — | `filled/desktop/chat-rich-dark-sec0..1.png`, `filled/desktop/chat-tools-dark-sec0.png` | Coverage: dark palette keeps the same hierarchy — sidebar/content surfaces separate, code and table borders readable, cards keep their border instead of a shadow. No defect. | — |
| — | — | — | — | — | — | `filled/desktop/chat-rich-de-sec0..1.png` | Coverage: chrome is German ("Neuer Chat", "UNTERHALTUNGEN", "Überlegung", "Abmelden", "Nachricht senden…"); the seeded session titles and prompts stay English because they are fixture data, not UI strings. No layout overflow at 768 px. | — |
| — | — | — | — | — | — | `filled/desktop/chat-tools-expanded-sec0.png` | Coverage: first tool card's input section expanded (`aria-expanded="true"`) shows the raw JSON in a code block; the collapsed output row keeps its chevron. No defect. | — |
| UI-1 | low | open | orchestrator | #27 | `apps/web/src/chat/Transcript.tsx:104` | `filled/desktop/chat-rich-sec0.png` | Jump-to-latest is a white disc on white content, floating over the last block. | Solid background, stronger border/shadow, larger inset. |
| UI-6 | medium | open | orchestrator | #27 | `apps/web/src/render/Mermaid.tsx` | `filled/mobile/chat-rich-sec1.png` | Diagram labels shrink to ~7 px at 390 px width. | Minimum width plus horizontal scroll (or tap-to-zoom). |

## Filled · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `filled/mobile/chat-rich-sec0..1.png` | Coverage: header stack, user bubble, table, blockquote, code, math, mermaid and tool card. No horizontal page overflow; code scrolls inside its block. | — |
| — | — | — | — | — | — | `filled/mobile/chat-tools-expanded-sec0.png` | Coverage: expanded input panel grows the card by one code block and still fits the viewport (`maxScrollY` 0); the second card and the error card stay collapsed. | — |
| — | — | — | — | — | — | `filled/mobile/chat-rich-dark-sec0..1.png`, `filled/mobile/chat-tools-dark-sec0.png` | Coverage: dark surfaces hold at 390 px; the code block and the tool-card borders stay distinguishable. | — |
| UI-1 | low | open | orchestrator | #27 | `apps/web/src/chat/Transcript.tsx:104` | `filled/mobile/chat-rich-sec0.png` | Same jump-to-latest disc, here overlapping the code block header. | As above. |
| UI-6 | medium | open | orchestrator | #27 | `apps/web/src/render/Mermaid.tsx` | `filled/mobile/chat-rich-sec1.png` | Same unreadable diagram labels. | As above. |

## Tablet · 820 px

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/tablet/landing.png`, `empty/tablet/landing-drawer.png`, `filled/tablet/chat-rich-sec0..1.png` | Coverage: sidebar collapses behind the header button, the 768 px column keeps its measure, composer spans the width minus 40 px. Drawer open: 340 px panel over a full-width scrim, underlying content inert, `aria-modal="true"`; the scrim is the dismiss affordance since it covers the toggle. No defect. | — |

## Wide · 1920 px

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/wide/login.png`, `empty/wide/landing.png`, `filled/wide/chat-rich-sec0..1.png` | Coverage: the login card stays narrow while locale/theme controls sit at the far right; the chat column stays at its 768 px measure. No defect. | — |
| UI-1 | low | open | orchestrator | #27 | `apps/web/src/chat/Transcript.tsx:104` | `filled/wide/chat-rich-sec0.png` | The jump-to-latest disc sits bottom-centre and, at 1920 px, lands in the middle of the visible tool card instead of clearing it. | As above; the disc needs a solid surface so the overlap reads as a layer, not as broken content. |

## Dictation · recording (390 / 1440)

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/desktop/chat-empty-recording-sec0.png`, `empty/mobile/chat-empty-recording-sec0.png` | Coverage: recording pill above the composer with a pulsing dot, `0:01` clock, level meter, stop and cancel; the mic in the composer stays visible and turns red (`aria-pressed`). The pill spans the composer width and pushes the composer down without clipping; at 390 px the stop and cancel targets stay 36 px square with 4 px gaps. No defect. | — |
| UI-8 | low | open | orchestrator | #27 | `apps/web/src/dictation/DictationButton.tsx:77` | `empty/desktop/landing.png`, `empty/mobile/landing.png` | Resting state: the ghost mic has no surface, unlike the send disc. In the recording state it gains the same grey disc, so the affordance changes shape between states. | Give the idle mic the same surface as send, or make both ghost. |

## Mobile drawer (390 px)

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/mobile/landing-drawer.png` | Coverage: drawer takes `min(340 px, 85vw)` (≈331 px here), full-height scrim over the inert chat, theme/locale/sign-out footer visible at the bottom. No defect. | — |

## Open follow-ups

- Fix the remaining medium finding (UI-6, mermaid on mobile) and the low
  ones in #27; re-capture `chat-rich` and `login`, then re-run
  `ratchet check --tier fast` (the registry counts open critical/high findings,
  currently zero).
- Dictation has one captured state per breakpoint (recording, 390 and 1440).
  Add the transcript-inserted composer, the error line and the limit notice as
  variants when the dictation slice gets its second UI round; the behaviour
  itself is covered by unit and E2E tests.
- The sidebar in the captures lists the four seeded chats. The earlier
  duplicate-title artifact (each Playwright project re-running its own seed) is
  gone: a single `seed` project creates them once per run, and the viewport
  projects only read the seed file.
- Still not captured: `bash: pre` output panels of a tool card, the drawer over
  a populated transcript, hover/focus states, permission and attachment UI.
  Add them as manifest variants once M3 lands.
