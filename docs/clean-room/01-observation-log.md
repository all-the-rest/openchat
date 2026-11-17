# 01 — Observation Log

**Status:** 2026-11-17. First authenticated pass done on desktop (1281 × 1143 CSS
px, DPR 1, `lang="de-DE"`, light theme). Chat titles, message contents and
account details are redacted; synthetic probe prompts only.

## Format

```
OBS-NNN | E0–E5 | date | surface | observation | reproduction
```

## Public metadata (no login)

### OBS-001 — Public app shell is reachable

`OBS-001 | E4 | 2026-11-17 | App shell | https://chatgpt.com returns HTTP 200, Content-Type text/html, title "ChatGPT", Express backend behind Cloudflare, SSR shell with a nonce-based CSP. | curl -sI https://chatgpt.com`

No statement about the authenticated UI. It only proves that the surface is
server-rendered and delivered as an app shell.

### OBS-002 — CSP `frame-src` shows rendering targets

`OBS-002 | E4 | 2026-11-17 | App shell | The CSP allows frames from *.chatgpt.site, *.embed.chatgpt.site, *.web-sandbox.oaiusercontent.com, file-frame.oaistatic.com, codepen.io, youtube.com, player.vimeo.com, google.com/maps, maps/embed, embed.apple-mapkit.com, docs.google.com, drive.google.com, onedrive.live.com, *.sharepoint.com. | curl -sI https://chatgpt.com`

Hypothesis (E0): these origins cover generative apps/widgets, the artifact
sandbox, file previews, code/embed previews, maps and third-party
integrations. The mapping must be verified before it becomes a requirement.

### OBS-003 — CSP `connect-src` shows realtime and media paths

`OBS-003 | E4 | 2026-11-17 | App shell | The CSP allows wss://*.chatgpt.com, wss://realtime.chatgpt.com, wss://multiplayer-u0.api.openai.com, wss://pages-realtime.gateway.unified-*.api.openai.com, images.openai.com, cdn.openai.com, checkpoints-*.files.openai.com, *.oaiusercontent.com, api.mapbox.com, events.mapbox.com. | curl -sI https://chatgpt.com`

Hypothesis (E0): realtime streaming, voice mode, collaborative editing
("Pages"/canvas), image delivery, code-interpreter files and maps. Do not use as
a requirement until the UI shows it.

### OBS-004 — Static resources and fonts

`OBS-004 | E4 | 2026-11-17 | App shell | The CSP loads styles/fonts from *.oaistatic.com, cdn.openai.com and fonts.gstatic.com; a Lottie sample and "openai-sans" font data are referenced. | curl -sI https://chatgpt.com`

This suggests animations (Lottie) and custom typography. Do not copy assets.

### OBS-005 — No access to the authenticated UI (resolved)

`OBS-005 | E0 | 2026-11-17 | All | The browse extension was not connected at start time; authenticated surfaces could not be observed. Resolved later the same day. | browse status`

## Authenticated observation — desktop

Viewport 1281 × 1143, DPR 1, browser language `de-DE`, light theme. The UI was
in German; labels below are translated, not copied verbatim at length.

### OBS-010 — App shell: three regions, 52 px header

`OBS-010 | E2/E3 | 2026-11-17 | App shell | The shell has a fixed left sidebar (340 px), a top header (52 px) spanning the content column, and a single scrollable main column (941 px at this viewport). | snapshot + getBoundingClientRect`

Details:

- `aside` 340 × 1143 at x 0; `main` 941 × 1143 at x 340; both share the page
  background `rgb(252, 252, 252)`.
- Header is 52 px high, drawn over the content column, with the mode switch
  centered and one icon at the far right.
- The sidebar is visually separated by a 1 px vertical rule at x ≈ 339 and
  scrolls independently (scroll container starts at y 95).
- There is no persistent right rail on the empty/chat surface at this width.

### OBS-011 — Sidebar information architecture

`OBS-011 | E1/E2 | 2026-11-17 | Sidebar | Top-to-bottom: brand row with account menu and search and collapse controls; primary actions New chat, Plan, Library, Plugins, Discover; collapsible sections Pinned, Projects, Recent; profile footer with plan badge. | snapshot`

Details:

- Primary rows are 35 px high, 328 px wide at x 6, radius 8, gap 8, padding
  6 × 10, 14 px / 20 px labels.
- "New chat" is the only row with a persistent selected background
  (`rgba(0,0,0,0.05)`) on the landing surface.
- Section labels ("Pinned", "Projects", "Recent") are 14 px / 18 px, weight
  500, color `rgb(143,143,143)`, at x 16.
- Projects expand inline to show their chats, indented below the project row.
- Recent chats are single-line, truncated with ellipsis; the active chat gets a
  rounded highlight and a trailing status indicator.
- Footer shows avatar, display name and plan badge ("Plus") in two lines.

### OBS-012 — Landing surface and composer anatomy

`OBS-012 | E1/E2 | 2026-11-17 | Landing | Centered H1 (24 px / 28.8 px, weight 400; at least two copy variants observed), a 768 × 52 px composer pill (radius 26, white, layered soft shadow), and in one state a single suggestion chip below it. | screenshot + computed styles`

Details:

- Composer shell: 768 × 52 at x 427, background `#fff`, radius 26 px, shadow
  `0 0 0 1px rgba(0,0,0,.04)`, `0 2px 8px rgba(0,0,0,.04)`,
  `0 4px 80px 8px rgba(0,0,0,.024)`.
- Inner form: 768 × 52, gap 8; left "+" button 36 × 36 (full radius), text field
  536 × 26 (16 px / 26 px), model button 84 × 36 with a chevron, dictation
  button 36, voice button 36 × 36 in green `rgb(83,181,89)`.
- Placeholder and model label use `rgb(143,143,143)`.
- The composer is centered in the content column, not in the viewport.
- H1 sits 22 px above the composer; the suggestion chip 24 px below.
- Suggestion chip: 768 × 52, radius 16, 16 px, muted text, one leading emoji,
  single line truncated.
- The suggestion content is account-derived (personalization). Not recorded.

### OBS-013 — Mode switch and temporary chat

`OBS-013 | E2 | 2026-11-17 | Header | A segmented control (224 × 36, radius 9999) with two modes, "Chat" (active) and "Work". A separate "Temporary chat" button sits in the shell above the composer. | snapshot + screenshot`

- Active segment: 112 × 36, radius 9999, white surface, 14 px / 20 px weight
  500; inactive segment label `rgb(93,93,93)`.
- "Temporary chat" is a pill button without an icon, placed above the H1.

### OBS-014 — Model and reasoning-effort picker

`OBS-014 | E2/E3 | 2026-11-17 | Composer | The model button opens a popover above the composer titled "Thinking effort" with a 3-step slider (current: High, step 3 of 3), a "Choose model" row, a "Performance" row, and a radio list of models (GPT-6 checked, GPT-5.6 Sol unchecked). | click + snapshot + screenshot`

- Effort is a discrete 3-step slider, not a free value; the status line reads
  "High, 3 of 3".
- Model selection is a radio list inside the same popover; the trigger label is
  the short effort name ("High"), not the model name.
- Popover is anchored above the composer, right-aligned to it, white, radius
  ~16, soft shadow.

### OBS-015 — Streaming state

`OBS-015 | E2/E3 | 2026-11-17 | Thread | After send, the user message appears immediately, the send button becomes "Stop", the share action is disabled, a thinking status is announced, and the chat title is auto-generated from the prompt. | send + snapshot`

- Streaming indicator: a status element, announced to assistive tech; visually
  a small animated dot cluster near the last block while waiting.
- The thread exposes screen-reader headings "You said:" and "Latest answer"
  (level 4), i.e. message groups are labelled landmarks.
- The chat title in the header and in the sidebar history updates while the
  session is still generating.
- Sharing stays disabled until the turn completes.

### OBS-016 — Markdown, table, code and math rendering

`OBS-016 | E1/E2 | 2026-11-17 | Thread | The assistant answer rendered as an ordered list containing: inline bold/italic/code and a link, an H2 (18 px / 28 px, weight 600), a bullet list, a 3-column table, a labelled code block, inline KaTeX math, raw `\[ … \]` text, and a diagram block with its own options. | synthetic probe prompt`

Details:

- Assistant column: 736 px text width inside the 768 px thread column (16 px
  inset each side); body 16 px / 26 px, color `rgb(13,13,13)`.
- Table: full 768 px, cells 14 px / 20 px, padding `8px 8px 8px 0`, header
  weight 600, horizontal rules only, no zebra striping, no outer border.
- Code block: rounded container, header row with language icon, language label
  ("TypeScript") and two icon actions (toggle line wrap, copy); code 12 px mono
  with 20 px line height on a light gray surface.
- Inline math renders with KaTeX (serif math font, ~19.4 px); a `\[ … \]` block
  remains visible as raw text with backslashes. Only `$…$` inline math is
  confirmed; block syntax needs a dedicated probe.
- The diagram block offers "Diagram options" and "Expand diagram" actions and
  a copy action, i.e. diagrams are first-class blocks, not code blocks.
- A trailing numbered item with no content still renders its number, which
  shows the renderer does not repair malformed list structure.

### OBS-017 — Message actions and scroll affordance

`OBS-017 | E2 | 2026-11-17 | Thread | Completed assistant turns expose: copy, rate, read aloud, share, more actions. User turns expose: copy, share prompt, edit. When scrolled up, a circular "Scroll to bottom" button floats above the composer. | snapshot`

- Actions are icon buttons in a row below the answer; no persistent toolbar on
  hover-only.
- The scroll-to-bottom affordance is a 36 px circular button centered over the
  thread, 24 px above the composer.

### OBS-018 — Multiline composer expands

`OBS-018 | E2 | 2026-11-17 | Composer | With multi-paragraph input the composer grows and adds an "Expand" control in its toolbar; the model, dictation and send controls stay at the bottom row. | fill + snapshot`

- The text field grows to a maximum, then the composer offers an explicit
  expanded editor.
- Attachment/tool row is above the text once the composer is multiline.

### OBS-019 — Personalization leaks into the landing surface

`OBS-019 | E1 | 2026-11-17 | Landing | The single suggestion chip on the landing surface is derived from the account's stored memory/preferences, not from a fixed catalogue. | screenshot (content not recorded)`

Consequence for our product: suggestions must be opt-in and derived only from
local data; the default must be static or hidden. No personalized text is
recorded here.

### OBS-027 — Dark theme tokens

`OBS-027 | E1/E2 | 2026-11-17 | Theme | With the dark theme active the app background is #000000, primary text #ededed, muted text #afafaf, user bubble #2c6732 with #effaf3 text; the composer is a near-black translucent surface with a 1 px inset highlight, code blocks sit on #303030. | emulate colorScheme dark`

Details:

- The theme is applied as `data-theme="dark"` on the root element, not only via
  `prefers-color-scheme`; the reference follows the system setting.
- Composer shell: `rgba(27,27,27,0.95)` equivalent, radius 26–28, inset shadow
  `0 0 1px rgba(255,255,255,0.2)`.
- Code block surface: `#303030`; the block keeps a large radius (~24).
- Selected sidebar row and hover use a light overlay on black, not a fixed gray.
- Text contrast in dark mode is high; the user bubble keeps a green hue with
  light text.

### OBS-028 — Mobile layout at 390 × 844

`OBS-028 | E1/E2 | 2026-11-17 | Responsive | At 390 px the sidebar disappears behind a drawer toggle, the header keeps 52 px with a centered title button (15 px/20, 36 px high), the thread uses 16 px side insets, and the composer becomes a two-row block: text field on top, plus/effort/mic/voice below. | emulate viewport 390×844, mobile`

Details:

- Header: menu button left, new-chat icon, centered title with chevron, share
  right.
- User bubble: `max-width: 70%`, radius 22, same padding as desktop; long text
  wraps, so a 251 px bubble was observed at this width.
- Composer: 358 px wide at x 16, form 87 px high, radius ~28; text field on its
  own row, controls below.
- The scroll-to-bottom button floats above the composer, centered.
- No right rail; artifact/file surfaces are expected as full-screen sheets
  (not yet probed).
- Desktop sidebar is reachable as an overlay drawer.

### OBS-029 — Session title menu

`OBS-029 | E2 | 2026-11-17 | Header | The title opens a 240 px menu (radius 16, padding 10, translucent surface) with 36 px rows: rename, pin, plugins submenu, lock chat, show files, archive, delete, move to project. Playback status "Answer complete" is announced separately. | click title + snapshot`

- Rows are 220 × 36, 14 px, radius 12, padding 6 × 10.
- Destructive actions (delete) are in the same list, not separated visually at
  this level.
- "Lock chat" is a privacy feature; "show files" is a session-scoped file list;
  "move to project" is a submenu.
- Completion is announced with a status element ("Answer complete"), separate
  from the visual finish.

### OBS-030 — Destructive confirmation and rotating landing copy

`OBS-030 | E2 | 2026-11-17 | Dialog / Landing | Deleting a chat opens a modal confirm with an irreversible warning, a pre-checked option, Cancel and a destructive confirm button. After deletion the landing shows a different H1 variant ("What should we start with?") and no suggestion chip. | click title → Delete → confirm`

- The confirmation names the chat, states irreversibility and offers cancel.
- An option is pre-checked by default; a destructive default deserves a review
  in our product. We require an explicit, unchecked choice.
- The landing H1 is not fixed: at least two variants were observed, and the
  suggestion chip is absent in a fresh state. The implementation must not
  assume a single string.

## Pending observations

| ID | What | Why it matters | Status |
| --- | --- | --- | --- |
| OBS-020 | Artifacts and preview panel | Largest UI block | open |
| OBS-021 | Image generation and image display | Media | open |
| OBS-022 | File/PDF attachments and previews | Composer | open |
| OBS-023 | Web search, citations, source cards | Research | open |
| OBS-024 | Deep research / agent mode ("Plan") | Planning and history | open |
| OBS-025 | Projects, tasks, GPTs/apps ("Plugins", "Discover") | Information architecture | open |
| OBS-026 | Settings, connectors, model configuration | Auth/config | open |
| OBS-027 | Dark theme tokens | Both themes required | done |
| OBS-028 | Mobile layout and breakpoints | Responsive | done |
| OBS-029 | Keyboard, focus, screen readers, reduced motion | Accessibility | open |
| OBS-030 | Error, empty, loading and offline states | Completeness | open |
| OBS-031 | Share/export/print | Output | open |
| OBS-032 | Stop, retry, edit and branch behavior | Core interaction | open |
| OBS-033 | Block math (`$$…$$`) and malformed Markdown | Renderer edge cases | open |
| OBS-034 | Composer "Work" mode | Scope decision | open |
