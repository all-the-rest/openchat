# Interactive Elements in a Normal Chat

**Status:** 2026-11-17. Observation of an owner-provided chat
(`https://chatgpt.com/c/6afab471-…`, redacted) that contains an inline
interactive calculator. This closes the "in-message interactive element" gap
that OBS-020 left open for the artifact right rail, and feeds FR-37 … FR-40
and [architecture 07](../architecture/07-artifact-runtime.md).

Evidence IDs: OBS-040 (observation log). Raw screenshots live in
`references/raw/` and are not committed. No reference markup, styles or copy is
reproduced here — only structure, measurements and behavior.

## What is on screen

The element sits in the flow of an assistant message, in the middle of a
long answer:

```
assistant prose
  h2 section heading
  one lead-in paragraph
  interactive card          ← the element
  prose continues
  next h2 section
```

It is not a right-rail panel and not a modal. It scrolls with the transcript,
takes the full content width of the message column, and the answer keeps going
below it. There is no surrounding toolbar, no "open" affordance, no reset or
download control in this example.

Inside the card, top to bottom:

| Part | Observation |
| --- | --- |
| Title | one short bold line, plain text |
| Control row | label on the left, current value right-aligned in the same row |
| Slider | full-width range input, thin track, circular thumb, no tick marks, no visible min/max |
| Section label | small bold line above the radio group |
| Radio group | two options, custom circular indicators, one selected |
| Divider | 1 px rule |
| Key/value rows | four rows, label left, euro value right, tabular alignment |
| Summary | muted caption plus a large emphasized result, right-aligned above it |

The whole surface is a card: light background, 1 px border, ~16 px corner
radius, ~16 px inner padding, no shadow. It reads as part of the message, not
as a panel.

## Rendering mechanism

The card is **not** DOM in the chat document. It is an iframe:

| Attribute | Value |
| --- | --- |
| `src` | `https://cdn.platform.openai.com/deployments/dil/v15/runner.html` |
| `title` | `DIL execution sandbox` |
| `sandbox` | `allow-scripts` (only) |
| `referrerpolicy` | `no-referrer` |
| `loading` | `auto` |
| `allow` | absent |

Facts that follow:

- No `allow-same-origin`, so the frame cannot read the parent document, cookies
  or storage of the app origin. The parent cannot read the frame's DOM either.
- The app CSP allows the `cdn.platform.openai.com` frame origin; the frame
  itself loads a versioned runner (`v15`), so the rendering contract is versioned
  in the URL.
- Height follows content: there is no inner scrollbar in the observed card.
- A snapshot of the page flattens the frame's accessibility tree into the
  parent's, which is a debugging artifact of the automation protocol, not
  something assistive technology sees. A screen reader sees one nested
  document whose accessible name is the frame title — here "DIL execution
  sandbox", which says nothing about the content.

## Behavior

Exercised on the live page:

1. Changing the slider with the keyboard (two `ArrowRight` presses) updates
   every derived value in the card immediately, including the large result.
2. Selecting the other radio option updates the same rows and the result
   immediately.
3. Neither interaction sends a request to the app origin or reloads the frame;
   the computation is local to the frame.
4. The surrounding prose does not move or re-render; only the card height
   changes when a value wraps.
5. The controls keep their state while the message stays mounted. Scrolling the
   message out of view and back did not reset it.

## Accessibility read

Observed in the flattened tree:

| Element | Accessible name |
| --- | --- |
| slider | `Slider` |
| radios | `radio`, `radio` |
| result | exposed as a heading (`level=1`) with the value as text |

So the visual labels ("assumed useful life", the radio option texts) are **not**
programmatically associated with their controls, and the computed result is a
heading whose level collides with the page structure. A screen-reader user gets
values but no context, and the recomputed total is not announced.

This is a reference weakness, not a pattern to copy. Our implementation must do
better (below).

## Other interactive variants in normal chats

Three more owner-provided chats show that "interactive" is a family of
surfaces, not one widget. Evidence: OBS-041.

### Search results and place cards

- Each result is a **link card**: a button labelled with the page title, a
  thumbnail image (116 × 116), the site name as a small chip button, and a
  per-card action ("add to favourites").
- Results are laid out in a short list inside the prose, not in a table.
- A **map card** follows the list: a Mapbox canvas 500 × 400 in a rounded
  container, "map sources" disclosure in the corner, and an explicit "expand
  map" control. The map never takes over the message area; expansion is opt-in.
- The map is host-rendered (Mapbox GL in the chat DOM), not an artifact. It
  needs network tiles and is therefore out of scope for our offline artifacts;
  it belongs to a future "place card" renderer with a static fallback.

### Chart card

- The chart is a **host-rendered widget** (Recharts) inside the message DOM,
  ~27 rem tall, responsive width, with axis titles, grid and four bars.
- A toolbar appears on hover/focus at the card's top right with two controls:
  share and "chart options".
- The options menu offers exactly two actions: **toggle between chart and
  table** (renders the same data as an accessible table) and **download as
  image**.
- Values in the surrounding prose stay as text; the chart is an addition, not a
  replacement for the numbers.

### Draft email card

- The assistant produces a **composer, not a text block**: recipient button,
  subject field (plain `textarea`), and a large `contenteditable` body
  (~600 px tall) with paragraph structure.
- Above it sits a small action group: open in mail app, open in mail, connect a
  mail account. The body stays editable in place and can be revised in follow-up
  turns.
- The card is inline in the message flow, no modal; the composer's own toolbar
  is minimal (copy, rate, read aloud, share).
- Accessible naming is thin: the body field is exposed as a textbox labelled
  with its placeholder ("start typing"), and the action group has no label.

## Comparison with the OpenChat design

| Aspect | Reference (observed) | OpenChat (spec 05, arch 07) |
| --- | --- | --- |
| Where | inline in the message, in flow | inline message part for small apps; right rail / sheet for large ones |
| Isolation | iframe, `allow-scripts` only, separate origin | iframe, `allow-scripts` only, separate artifact origin with signed URL |
| Runtime | proprietary runner, versioned in the URL | one self-contained HTML document compiled at write time, no `eval`, no CDN |
| Creation | model output rendered by the service | `openchat_app_write` tool: validate, compile, store; errors return into the turn |
| Network | not observable from the parent | `connect-src 'none'`, CSP on the artifact host |
| State | local, survives scroll | local, reset via control; no persistence |
| Controls | none in this example | reset, present/fullscreen, download |
| Result back to chat | none in this example | validated `postMessage` bridge, draft message (FR-39) |
| Height | content-sized | `setHeight(px)` through `window.openchat` |
| A11y | unlabeled controls, result as `h1` | labelled controls, `aria-live="polite"` result, frame titled after the artifact |

## Consequences for our build

1. **Keep the inline placement.** An interactive element belongs in the message
   flow when it is small; the right rail is for documents and large apps. Spec
   05 already allows both — this observation confirms the inline variant is
   real and common.
2. **Set the iframe title from the artifact title**, never a generic runtime
   name. The frame title is the only thing a screen reader announces before
   entering the document.
3. **Require programmatic labels.** `window.openchat` docs and the artifact
   template must show `<label for>`/`aria-label` and a `radiogroup` with a
   name; the audit fixture should assert accessible names, not just visible
   text.
4. **Announce recomputed results politely.** The artifact bridge gets an
   optional `announce(text)` or the template wraps its result in
   `aria-live="polite"` so a changed total is read once, not on every tick.
5. **Version the rendering contract.** The reference pins `dil/v15`; our
   artifact HTML embeds its own runtime, so version the document format
   (`data-oc`) instead of a runner URL.
6. **Match the card shape, not the pixels.** Border, radius, padding and the
   key/value alignment map to spec 08 tokens; the artifact template should ship
   those values so model-written apps look native without inventing styles.
7. **No toolbar chrome inside the card.** Controls stay in our app chrome
   around the frame, which keeps the artifact content-only and the chrome
   translatable.

## Open questions

- Whether the reference re-renders the frame on theme or locale change; not
  exercised (would need a second turn and a theme switch).
- Whether a large app switches to a side panel automatically; not exercised
  (OBS-020 stays open for the artifact panel itself).
- How the reference sizes a frame with an internal scroll area; not exercised.
