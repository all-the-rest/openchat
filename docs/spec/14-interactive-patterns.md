# 14 — Interactive Chat Patterns

**Status:** v2 design (2026-11-17). Evidence: OBS-040, OBS-041, OBS-016, OBS-017.
Implements FR-37 … FR-40 together with
[`05-rendering.md`](05-rendering.md) and
[`../architecture/07-artifact-runtime.md`](../architecture/07-artifact-runtime.md).

This document is a **catalogue of reusable patterns** for elements that are more
than text: cards with input, live numbers, charts, drafts, links. Each pattern
is a snippet the builder can implement once and reuse, instead of inventing a
new card per model output.

## Why a catalogue

A chat surface grows random one-off cards quickly. The reference shows the
opposite: a handful of shapes, repeated (OBS-040, OBS-041). A catalogue gives
us three things:

1. **One renderer per shape**, so the transcript stays consistent and the CSS
   stays small.
2. **A structured payload** per shape, so the model cannot inject markup and
   the tests can assert data instead of pixels.
3. **A decision rule** for the hardest question: host component, sandbox
   artifact, or plain Markdown.

## Decision rule

| Shape | Renderer | Why |
| --- | --- | --- |
| Numbers, labels, a table, a short list | Markdown | No interactivity needed |
| Fixed interaction with known fields (slider, radio, step) | **Host card** | Predictable, themed, accessible, no sandbox cost |
| Chart from model-provided data | **Host card** | Data only; we render, so no code runs |
| Arbitrary computation, simulation, custom UI | **Sandbox artifact** | Unbounded behavior needs isolation |
| Editable long-form text (mail, document) | **Composer card** | Editing and submission are app behavior, not artifact behavior |
| Anything that needs network, cookies, or the session | **Not allowed** | See exfiltration limits in spec 05 |

Rule of thumb: if the model can express it as **data**, it is a host card. Only
when it needs **code** does it become an artifact.

## Baseline rules for every pattern

- Payloads are JSON, schema-validated on the server; the UI never renders model
  HTML outside a sandboxed artifact.
- Every card is a `section` with an accessible name from its title.
- Every control has a programmatic label; every recomputed value is announced
  once through `aria-live="polite"`, never on every keystroke.
- Cards are content-sized, full column width, no inner scroll below 480 px
  height; above that the card scrolls with a visible edge.
- Tokens only: `--surface`, `--border`, `--radius-lg`, `--text`, `--text-muted`,
  `--accent`. No raw hex in components (spec 08).
- No toolbar inside the card. Controls that act on the card live in the message
  action row; controls that act on data live in the card's header row.
- A failed payload renders an ErrorCard with the schema message, never a blank
  card.
- Every pattern ships a fixture and a unit test; every interactive pattern also
  ships a keyboard test.

## Catalogue

| ID | Pattern | Renderer | Milestone |
| --- | --- | --- | --- |
| P-01 | Parameter card (control → live result) | host | M2 (static) / V2 (live) |
| P-02 | Chart card with table toggle | host | M5 |
| P-03 | Result link card | host | M5 |
| P-04 | Place card with map | host (static fallback) | M5 |
| P-05 | Comparison table with source chips | host | M2 |
| P-06 | Draft composer card | host | V2 |
| P-07 | Step and duration disclosure | host | M2 |
| P-08 | File pill | host | M1 |
| P-09 | Form card | host | M3 |
| P-10 | Permission card | host | M3 |
| P-11 | Sandbox artifact | iframe | M4 / V2 |

## P-01 — Parameter card

Use when one to three inputs drive a computed value the user wants to explore.

- **Data:** `{ title, inputs: [{ id, kind: "range"|"choice", label, min?, max?,
  step?, unit?, value, options? }], rows: [{ label, value }], total: { label,
  value } }`.
- **Anatomy:** title row; one row per input with the label left and the current
  value right; result rows as aligned key/value; one emphasized total.
- **Behavior:** recompute locally and synchronously; no request, no reload; the
  initial state comes from the payload, reset returns to it.
- **A11y:** `<label for>` on every control, `<fieldset>`/`<legend>` for a group,
  total in `aria-live="polite"`, values as text (not only color).
- **Tests:** slider arrow keys change the total; choosing an option changes the
  rows; reset restores the payload; the total is announced once.

```tsx
<section aria-labelledby="card-title">
  <h3 id="card-title">{title}</h3>
  {inputs.map((input) => (
    <div className="flex items-baseline justify-between gap-4">
      <label htmlFor={input.id}>{input.label}</label>
      <output htmlFor={input.id}>{format(input.value)}</output>
    </div>
  ))}
  <dl>{rows.map((row) => <div><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
  <p aria-live="polite">{total.label}: {total.value}</p>
</section>
```

## P-02 — Chart card with table toggle

Use when a series matters more than the exact numbers, and the numbers exist
anyway.

- **Data:** `{ title, caption?, kind: "bar"|"line", categories: string[],
  series: [{ name, values: number[] }], unit? }`.
- **Anatomy:** title, optional caption, chart, header-row toggle between chart
  and table, download-as-image.
- **Behavior:** the table view renders the same data as a real `<table>`; the
  toggle is a segmented control with `aria-pressed`; the chart is decorative
  (`role="img"` with an accessible description) because the table carries the
  values.
- **A11y:** never rely on color alone; the table is the accessible source;
  caption names category and unit.
- **Tests:** table rows equal the series; toggle keeps data; chart renders with
  `role="img"`; no network.

## P-03 — Result link card

Use for web results and workspace files.

- **Data:** `{ title, url, site, description?, image?, actions: [] }`.
- **Anatomy:** 116 × 116 thumbnail (optional), title as the primary button, site
  chip, one-line description, one secondary action.
- **Behavior:** the whole card is one target; external links open in a new tab
  with `rel="noopener noreferrer"`; no embedded page, no favicon fetch from a
  third-party origin (use the site name).
- **A11y:** the button name is the page title; the thumbnail is decorative
  (`alt=""`); the site chip is text, not an icon-only button.
- **Tests:** keyboard activates the card; no request leaves the origin for a
  thumbnail the payload marks as remote.

## P-04 — Place card with map

Use for locations. v1 renders the static fallback only.

- **Data:** `{ name, address, hours?, lat, lon, source }`.
- **Anatomy:** name, address, hours, a static preview (opaque image from our own
  origin or a neutral placeholder), "open map" action.
- **Behavior:** the map itself is opt-in and never loads on render; without a
  tile provider the card still shows address and hours.
- **A11y:** the map preview is decorative; the address is text; the action has a
  name.
- **Tests:** no third-party request on render; action opens externally with
  `rel="noopener noreferrer"`.

## P-05 — Comparison table with source chips

Use for prices, specs and any "row + evidence" data.

- **Data:** `{ title, columns: string[], rows: [{ cells: string[], source?:
  { label, url } }] }`.
- **Anatomy:** header row, 1 px rules only, right-aligned numeric cells, source
  chip per row or per section.
- **Behavior:** static; sorting is out of scope until a payload asks for it.
- **A11y:** `<caption>`, `<th scope="col">`/`<th scope="row">`, numeric cells
  with units in text.
- **Tests:** header cells are `th`; numeric alignment does not change the text;
  source chip has an accessible name.

## P-06 — Draft composer card

Use when the model writes something the user will edit and send.

- **Data:** `{ kind: "mail"|"text", to?: string[], subject?, body, actions:
  ("copy"|"open-in-app"|"connect")[] }`.
- **Anatomy:** recipient row, subject field, body region, action row.
- **Behavior:** fields are editable in place; edits stay local until the user
  copies, opens an app or asks for a revision; a follow-up prompt may produce a
  new draft (never silently overwrite user edits — show both).
- **A11y:** every field labelled; the body is a labelled `textarea` or a
  `contenteditable` with `role="textbox"` and `aria-multiline`; the action group
  has a name; no auto-send.
- **Tests:** editing body then copying yields the edited text; a new draft does
  not replace an edited one; Escape does not discard silently.

## P-07 — Step and duration disclosure

Use for tool steps and for a whole turn.

- **Step:** one line with tool name, status word, and a chevron; expands to the
  input and output (P-12 in spec 05, tool card).
- **Duration:** collapsed by default above the answer, e.g. a single line with
  the elapsed time; expands to the step list.
- **A11y:** `button[aria-expanded]`, status text in the accessible name, no
  timer that announces every second.
- **Tests:** collapsed by default; expansion is keyboard-operable; duration is
  stable after completion.

## P-08 — File pill

Use for files the turn produced or received.

- **Data:** `{ name, kind, size?, url }`.
- **Anatomy:** type icon, file name, optional size; one button.
- **Behavior:** opens the viewer (artifact, image, PDF) or downloads; never
  auto-opens.
- **A11y:** name includes the type ("PDF, 240 KB, report.pdf").
- **Tests:** button is reachable by keyboard; download path is same-origin.

## P-09 — Form card

See [`05-rendering.md`](05-rendering.md#form-card). Payload-driven fields,
field-level errors, `session.form.reply`.

## P-10 — Permission card

See [`05-rendering.md`](05-rendering.md#permission-card). The run stays paused
until a decision; the exact rule is shown before "always allow" is saved.

## P-11 — Sandbox artifact

Use when the model needs code: simulations, games, custom visualization.

- **Creation:** `openchat_app_write` with one Preact component; validation and
  compile at write time; no CDN, no network, no `eval`.
- **Placement:** inline in the message when the app is small; right rail or
  sheet when it is a document. Inline frames report their height through
  `setHeight`.
- **Chrome:** title, reset, present, download, close. No chrome inside the frame.
- **Frame:** `sandbox="allow-scripts"`, no `allow-same-origin`, signed URL,
  `referrerpolicy="no-referrer"`, `title` = artifact title.
- **Bridge:** `artifact:ready`, `artifact:resize`, `artifact:result` with a
  nonce; results become a draft, never an automatic message.
- **A11y:** the frame title is the only pre-entry announcement — it must name
  the app; inside, the template provides labels, landmarks and a polite live
  region for results.

```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  title="Interest calculator"
  src="/artifact/a/7f3?exp=…&amp;sig=…"
></iframe>
```

## Snippet checklist

For each new pattern:

1. Payload schema in `@openchat/contracts` with a zod parser.
2. One renderer, one fixture, one unit test, one keyboard test.
3. Tokens only; no hex, no `dark:` variants.
4. A11y: name, label, live region, no color-only meaning.
5. Failure path: schema error → ErrorCard; artifact error → source view.
6. i18n: every string in `en` and `de`, no literal in JSX.
7. Offline: no third-party request from a card that claims to work offline.
