# UI Review — OpenChat M1/M2 — 2026-11-17

Capture: `npx playwright test -c playwright.screenshots.config.ts` (in `apps/web`) ·
output: `apps/web/ui-review/` (gitignored) · 18 screenshots, 2 per route and
viewport, four breakpoints.

Verdict: **APPROVED** — no `critical` or `high` findings. One medium finding was
fixed during the review round; the rest are open in
[#27](https://github.com/all-the-rest/openchat/issues/27) and listed in
`ratchet.findings.json`.

## Coverage

| Route | State | Viewports | Screenshots |
| --- | --- | --- | --- |
| `login` | empty | 390, 820, 1440, 1920 | `empty/<viewport>/login.png` |
| `landing` | empty | 390, 820, 1440, 1920 | `empty/<viewport>/landing.png` |
| `chat-rich` | filled | 390, 820, 1440, 1920 | `filled/<viewport>/chat-rich-sec0..1.png` |
| `chat-tools` | filled | 390, 1440 | `filled/<viewport>/chat-tools-sec0.png` |
| `chat-error` | filled | 390, 1440 | `filled/<viewport>/chat-error-sec0.png` |
| `chat-empty` | empty | 390, 1440 | `empty/<viewport>/chat-empty-sec0.png` |

Scroll coverage is recorded per capture in the sibling `.json` files. The chat
transcript is the sampled inner scroller (`[data-testid="transcript"]`); at 1440
px the rich chat needs two sections (0 and 284 px), so top and footer were both
reviewed. Login and landing are short pages with a full-page overview.

What was **not** reviewed: dark theme, German locale, hover/focus states, the
mobile drawer open, tool cards expanded, permission cards (not implemented),
attachments and the artifact sandbox (not implemented in M1/M2).

## Empty · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/desktop/login.png` | Coverage: card centered at 384 px, top-right locale/theme controls, disabled submit clearly disabled. No defect. | — |
| UI-3 | low | open | orchestrator | #27 | `apps/web/src/pages/LoginPage.tsx:64` | `empty/desktop/login.png` | No product branding on the login card; the app header elsewhere shows "OpenChat". | Add a wordmark above the card. |
| UI-4 | low | open | orchestrator | #27 | `apps/web/src/pages/ChatPage.tsx:56` | `empty/desktop/chat-empty-sec0.png` | Empty chat is one muted line pinned under the header while the landing hero is centered. | Center the empty state or reuse the landing hero. |
| UI-2 | medium | fixed | orchestrator | #27 | `apps/web/src/chat/Transcript.tsx` | `filled/desktop/chat-error-sec0.png` | Error card promised a retry that did not exist. | Fixed 2026-11-17: Continue/Retry actions render under the last assistant message; regression test in `apps/web/test/transcript.test.tsx`. |

## Empty · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| UI-5 | low | open | orchestrator | #27 | `apps/web/src/chat/Composer.tsx` | `empty/mobile/landing.png` | "Enter sends, Shift+Enter adds a line" is shown on a touch viewport. | Hide under `(pointer: coarse)` or swap the copy. |
| UI-7 | low | open | orchestrator | #27 | `apps/web/src/pages/LoginPage.tsx:64` | `empty/mobile/login.png` | Password focus shows an outline plus border as a heavy double ring, close to an error affordance. | Use one focus ring. |

## Filled · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `filled/desktop/chat-rich-sec0..1.png` | Coverage: transcript at 768 px, table, math, code, mermaid, tool card and copy affordances render; sidebar 340 px. No defect. | — |
| UI-1 | low | open | orchestrator | #27 | `apps/web/src/chat/Transcript.tsx:104` | `filled/desktop/chat-rich-sec0.png` | Jump-to-latest is a white disc on white content, floating over the last block. | Solid background, stronger border/shadow, larger inset. |
| UI-6 | medium | open | orchestrator | #27 | `apps/web/src/render/Mermaid.tsx` | `filled/mobile/chat-rich-sec1.png` | Diagram labels shrink to ~7 px at 390 px width. | Minimum width plus horizontal scroll (or tap-to-zoom). |

## Filled · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `filled/mobile/chat-rich-sec0..1.png` | Coverage: header stack, user bubble, table, blockquote, code, math, mermaid and tool card. No horizontal page overflow; code scrolls inside its block. | — |
| UI-1 | low | open | orchestrator | #27 | `apps/web/src/chat/Transcript.tsx:104` | `filled/mobile/chat-rich-sec0.png` | Same jump-to-latest disc, here overlapping the code block header. | As above. |
| UI-6 | medium | open | orchestrator | #27 | `apps/web/src/render/Mermaid.tsx` | `filled/mobile/chat-rich-sec1.png` | Same unreadable diagram labels. | As above. |

## Tablet · 820 px

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/tablet/landing.png`, `filled/tablet/chat-rich-sec0..1.png` | Coverage: sidebar collapses behind the header button, the 768 px column keeps its measure, composer spans the width minus 40 px. No defect. | — |

## Wide · 1920 px

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `empty/wide/login.png`, `empty/wide/landing.png`, `filled/wide/chat-rich-sec0..1.png` | Coverage: the login card stays narrow while locale/theme controls sit at the far right; the chat column stays at its 768 px measure. No defect. | — |

## Open follow-ups

- Fix the remaining medium finding (UI-6, mermaid on mobile) and the low
  ones in #27; re-capture `chat-rich` and `login`, then re-run
  `ratchet check --tier fast` (the registry counts open critical/high findings,
  currently zero).
- The sidebar in the captures lists the seeded chats; a second Playwright
  project re-runs the seed and creates a duplicate title. Fixture artifact, not
  a UI defect.
- Not yet reviewed: dark theme, German locale, drawer open, expanded tool cards.
  Add them as manifest states once M3 adds attachments and permissions.
