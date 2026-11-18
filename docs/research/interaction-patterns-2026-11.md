# Interaction Patterns Across Eight Owner-Provided Chats

**Status:** 2026-11-18. Aggregate reading of eight owner-provided chats in the
reference web app. Purpose: see which response shapes and which conversational
moves actually recur, so the V2 message renderer and the turn model are built
from a distribution rather than from single examples.

Evidence IDs: OBS-043 … OBS-050. Note on numbering: OBS-041 and OBS-042 were
already assigned (inline interactive variants, planning surface), so this note
uses the next free block. Each section below is one chat, in the order the chats
were supplied; the IDs are stable and the matrix rows follow the same order.

Method: each chat was opened in its own tab, scrolled to the end in steps until
the scroll height stopped growing (the transcript is virtualised and re-mounts
turns), and the DOM was read structurally — element counts, not text. No
message text, no chat title, no URL, no screenshot and no account detail is
reproduced here.

## Aggregate

| Measure | Value |
| --- | --- |
| Chats observed | 8 |
| User turns | 26 |
| Assistant turns | 23 |
| User turns without a rendered assistant reply | 3 (two chats) |
| Chats with at least one table | 7 of 8 |
| Chats with link cards | 5 of 8 |
| Chats with an editable draft block | 4 of 8 |
| Chats with a reasoning/duration disclosure | 7 of 8 (9 disclosures total) |
| Chats with a canvas map | 1 of 8 |
| Chats with a chart, an iframe, a file pill or a generated image | 0 of 8 |

## Component matrix

`●` present, `◐` present once or only in some turns, `—` absent. Counts are the
maximum seen in a single turn of that chat.

| ID | Prose | Headings | Lists | Table | Inline code | Code block | Images | Links | Link cards | Source chips | Canvas/map | Reasoning | Draft card | Chart | Math |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OBS-043 | ● | ● | ● | ● | — | — | ● 13 | ● | ● 5 | ◐ 1 | ● | ◐ | ● | — | — |
| OBS-044 | ● | ● | — | — | — | — | ● 3 | ● | ◐ 1 | ◐ 1 | — | ◐ | ● | — | — |
| OBS-045 | ● | ● | ● | ● | — | — | — | ◐ 2 | — | — | — | ◐ | — | — | — |
| OBS-046 | ● | ● | — | ● | ● 17 | ● 3 | ◐ 2 | — | — | — | — | — | — | — | — |
| OBS-047 | ● | ● | ◐ | ● | — | — | ● 6 | — | ● 3 | ◐ 1 | — | ◐ | ● | — | — |
| OBS-048 | ● | ● | ● | ● | ● | — | ● 6 | ● | ● 2 | — | — | ◐ | ● | — | — |
| OBS-049 | ● | ● | — | — | ● 8 | — | ◐ 1 | — | — | — | — | ◐ | — | — | — |
| OBS-050 | ● | ● 18 | — | ● 4 | — | — | ● 7 | ◐ | ◐ 1 | — | — | ◐ | — | — | ◐ 1 |

Reading the matrix:

- **Prose plus headings is the baseline.** Every answer longer than a couple of
  sentences is Markdown with H2/H3 sections; the sectioned answer is the default
  shape, not the exception.
- **Tables carry the comparison work.** Seven of eight chats contain a table,
  usually two or three columns and four to six rows, always inside prose, never
  as a standalone panel. The one chat without a table is the one that never asks
  for a comparison.
- **Link cards and source chips are the research surface.** A card pairs a
  square thumbnail with a button labelled with the page title, a small site chip
  and a favourite action; a source chip is a small button carrying a site name
  and a `+N` count. Plain external links also occur, as ordinary anchors without
  a thumbnail.
- **The reasoning disclosure is nearly universal** and is a single collapsed
  line with a duration (values between 15 s and 37 s here).
- **The long tail is empty.** No iframes, no artifact/canvas panel, no charts, no
  file pills and no generated images appear in these eight chats. The only
  rendered graphic surface besides images is one map canvas.

## Per chat

### OBS-043

- **Turns:** 2 user, 2 assistant. Paired normally.
- **Components:** six headings in the first answer (five H2 plus one H1), one
  table (2 columns, 5 rows), five link cards with thumbnails and favourite
  buttons, one source chip, an inline map canvas (768 × 400) with its own
  sources disclosure and an expand control, one editable draft block, one
  reasoning disclosure (26 s), thirteen images. The second answer repeats the
  pattern at lower density (three headings, one table, four cards).
- **Shape:** the user pastes a product link and states a comparison intent in the
  same turn; the follow-up is a five-word request for more options, not a
  correction.
- **Outcome:** succeeds. The structured answer (sections, table, place cards,
  draft text) is usable without a second pass; the user answers by expanding
  scope, which is the healthy version of a follow-up.
- **Notable:** a single emphasised key figure is rendered as an **H1** in the
  middle of the answer, which breaks the document outline and reads as a layout
  shortcut rather than a semantic heading.

### OBS-044

- **Turns:** 5 user, 3 assistant. Two user turns never receive a rendered reply;
  one of them is a one-line correction of the entity in the previous turn.
- **Components:** three section headings in the longest answer (one of them a
  stray H1), three images, one link card, one source chip, one editable draft
  block, one reasoning disclosure (37 s). No table, no code, no map.
- **Shape:** research request → immediate entity correction → request to compose
  a message → request for a calendar entry → one-word follow-up. This is the
  clearest "spoken, incremental" thread in the set: short turns, self-corrections,
  and a request for a concrete side effect.
- **Outcome:** mixed. The composed-message turn succeeds and returns an editable
  draft. The calendar request returns plain prose only — no calendar object, no
  event card, no export affordance — so the user's request cannot be completed
  in the product. Two turns ending without any reply leave the thread looking
  broken rather than paused.

### OBS-045

- **Turns:** 1 user, 1 assistant.
- **Components:** three H2 sections, one table (3 columns, 6 rows), two lists,
  two plain inline links to one manufacturer site, one reasoning disclosure
  (20 s). No cards, no images.
- **Shape:** a pasted inventory line, no question mark, no instruction — the
  user supplies context and expects a comparison.
- **Outcome:** succeeds. One turn, one table, no follow-up. The weakest part is
  attribution: the two links are inline anchors, so there is no chip, favicon or
  visible source list.

### OBS-046

- **Turns:** 1 user, 1 assistant.
- **Components:** four H2 sections, one table (2 columns, 3 rows), seventeen
  inline code spans, three fenced code blocks, two small (thumbnail-sized)
  images. No links, no disclosure, no cards.
- **Shape:** a long, dictation-style problem description with no question mark
  and no structure — the user narrates a setup and stops. The assistant has to
  infer the question.
- **Outcome:** succeeds for a debugging turn: the answer is sectioned, code is
  separated from prose, and the summary table separates cause from fix. It has no
  sources, so nothing in the turn can be checked externally.

### OBS-047

- **Turns:** 3 user, 3 assistant. Paired normally.
- **Components:** up to four H3 subsections per answer, two tables (3 × 5 and
  2 × 4), six images, up to three link cards, one source chip, one editable draft
  block, two reasoning disclosures in the thread.
- **Shape:** a very short opening prompt → a request to research it online and
  verify a tax treatment → a dispute of the result plus a narrowed constraint
  (cheaper, EU shipping). This is a **verification-then-correction** loop: the
  user asks for an external check, then disputes the answer and changes one
  requirement.
- **Outcome:** mixed. The research turn returns a usable draft plus cards; the
  correction turn produces a shorter answer with two cards and no table, so the
  comparison the user was building is dropped exactly when the constraint
  changes.

### OBS-048

- **Turns:** 10 user, 10 assistant — the only long thread in the set.
- **Components:** every answer sectioned (up to seven H2s), one to three tables
  per answer, inline code in several answers, up to six images and two link
  cards, one editable draft block, two reasoning disclosures. No chart, no math.
- **Shape:** a pasted product link, then a pasted marketing blurb, then a price-
  trend argument, then a run of one-line challenges — whether a claim really
  holds, whether the assistant actually found the item in the shop, whether the
  cheaper option would not be better. The user alternates between supplying
  evidence and auditing the assistant.
- **Outcome:** mixed. Structurally the strongest thread (tables everywhere), but
  the repeated audit questions show the answers are not trusted: the assistant
  asserts rather than shows, and explicit source chips are absent in almost every
  answer even where external links exist.

### OBS-049

- **Turns:** 1 user, 1 assistant.
- **Components:** two H2 sections, eight inline code spans, one image. No table,
  no links, no disclosure.
- **Shape:** a single short instruction to research a set of four names, with
  the constraint list embedded in the sentence.
- **Outcome:** succeeds. Short, structured, copyable — the inline code spans are
  the useful part because the output is a set of literal strings.

### OBS-050

- **Turns:** 3 user, 2 assistant. One user turn (a parameter-heavy follow-up)
  has no rendered reply.
- **Components:** first answer eleven headings and two tables; final answer
  eighteen headings, four tables (4 columns, 6 rows), one formula, seven images,
  one link card, one reasoning disclosure. No code.
- **Shape:** capacity question → a follow-up that fixes the calculation
  parameters (percentages, price model) → a profitability question. The user
  iterates on assumptions rather than correcting facts.
- **Outcome:** mixed. The numbers are tabulated, but the final answer is a wall
  of eighteen sections with four tables and no summary, so the single figure the
  user asked for is buried. The unanswered parameter turn breaks the chain the
  calculation depends on.

## What OpenChat should borrow

1. **A first-class table block, not raw Markdown.** Tables are the dominant
   comparison shape (7/8 chats). Render them inline as today, but with a sticky
   header, tabular numerals, horizontal scroll on narrow widths, and "copy as
   CSV/Markdown". A one-line summary above the first table would fix the OBS-050
   failure where the answer is buried in the fourth table.
2. **Source chips at the claim, not at the end.** A chip per source with a
   favicon, a short site label and a `+N` overflow that opens a source popover.
   The reference already does this on research turns and skips it on others,
   which is exactly where trust breaks (OBS-048). Make the chip mandatory
   whenever a turn cites anything.
3. **Link cards with a fixed aspect ratio.** Thumbnail + host + title, one card
   per source, with a favourite action. The scroll height of the longest
   transcript grew by roughly 4 000 px between passes as thumbnails and turns
   mounted; reserve the box so the transcript does not jump.
4. **One collapsed duration/reasoning line per turn.** Already the reference
   pattern (15–37 s), one line, above the answer, collapsed by default, with the
   duration as text rather than a spinner that disappears.
5. **An editable draft card for composed text.** Recipient/subject/body or a
   plain editable body, with copy and "open in app". Four of eight chats produce
   one; in OpenChat it should be a message part with a defined result back into
   the conversation, not a `contenteditable` blob.
6. **A turn outline for long answers.** From ~600 words or ~6 headings, render a
   compact "in this answer" list (or sticky mini-TOC) in the message header. The
   eighteen-heading answer shows the failure mode without one.
7. **Side-effect requests get a component or an explicit refusal.** A calendar
   request produced prose and nothing else. If OpenChat cannot create the object,
   the turn should say so in one line and offer the nearest transferable artefact
   (e.g. a downloadable calendar file) instead of an explanatory paragraph.
8. **A visible "no reply" state.** Three user turns in two threads render with no
   assistant turn at all. OpenChat needs a distinct state (interrupted, failed,
   superseded) with retry, otherwise the transcript looks corrupt.
9. **Section headings are the model's job, the outline is ours.** Keep H2/H3 from
   the model, but never let emphasis become a heading (the stray H1) and keep one
   document outline per message.

## Limits

All eight chats were fully readable; the subscription banner is a persistent
header control and did not replace any message body in these threads, so no
bypass was attempted or needed. Because the transcript virtualises, turn and
component counts are what rendered across a full top-to-bottom walk, not a
server-side message count; a turn that never mounts would be missed, and turns
re-mounted while scrolling were de-duplicated by content hash. Two threads
contain user turns without any rendered reply, and those are reported as
observed rather than as a rendering fault. Component counts are structural (DOM
element counts per turn), so they describe shape only, and no heading, list or
table content was read out. No message text, no chat title, no URL, no
screenshot and no account detail was copied into this file; nothing here is
derived from reference markup or copy.
