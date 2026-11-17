# "Planen" (Scheduled Tasks) Surface

**Status:** 2026-11-17. Observation of the reference's planning surface, reached
from the sidebar in the chat/Codex shell. Purpose: decide what of it belongs to
our todo/task milestone (M5) and what is account chrome we must not copy.

Evidence: OBS-042. No reference markup or copy is reproduced; structure,
measurements and interaction affordances only.

## Entry and layout

- Sidebar entry "Planen" (clock icon), second item under "New chat", opens the
  route `/scheduled`.
- The page replaces the chat column; the sidebar stays.
- Header: H1 "Planen" (24 px), one-line description below it
  (~2 lines at 880 px content width), and a filter chip at the top right with a
  funnel icon and the current filter ("Aktiv").
- Below the header: a task composer, then the task list, then a "recommended"
  section.

## Task composer

A pill, same dimensions as the chat composer, with:

| Part | Behavior |
| --- | --- |
| plus button | add files/context |
| text field | placeholder "plan a task"; plain single line |
| dictation | mic; same component as in chat |
| send | circular, disabled while the field is empty |

Creating a task is therefore a **chat-style prompt**, not a form. The schedule
semantics (once, daily, weekly, watch) are described in natural language; the
product turns them into a schedule.

## Task list

Each task is a row, not a card:

```
[icon]  Title                            (hover actions)
        Schedule kind · next run
```

Observed rows:

| Title (redacted) | Schedule line |
| --- | --- |
| a price watch | "Monitoring · next run in 6 days" |
| a weekly deal check | "Weekly · next run in 3 days" |

Row affordances:

- The title is a button and opens the task.
- Hover/focus reveals: pause (pause icon, accessible name "… pausieren"),
  edit (pencil), and a "more task actions" menu.
- The row has no chevron and no card border; a 1 px rule separates rows.
- The schedule line is muted, one line, never wraps in the observed width.

Accessibility read: the list item's accessible name concatenates the title
three times (open, pause, edit buttons with the title in their names), which
makes the list verbose in a screen reader. Our version must name the row once
and give the icon buttons short names ("Pause", "Edit", "More").

## Recommended section

- Collapsible heading with a chevron ("Recommended"), expanded by default.
- Four suggestion rows: emoji-ish icon, bold title, one-line muted description,
  and a trailing plus button that prefills the composer.
- Suggestions are account-personalized in the reference. Ours must be static
  examples from the spec, or empty when no suggestions exist.

## Visual details worth reusing

- Rows are 1 px rules, 16 px vertical padding; no zebra, no shadows.
- The section divider between tasks and recommendations is a wavy rule — a
  decorative touch we can skip; a plain rule keeps the theme simpler.
- The filter is a chip, not a select; it opens a menu (not exercised).
- The whole page uses the same content width as the chat column (768 px), so
  switching between chat and tasks does not shift the reading column.

## What this means for OpenChat

Tasks are M5 (`docs/spec/06-agents-tasks.md`). This observation confirms:

1. **One list, one composer.** Tasks are created by prompt; the schedule is
   parsed server-side and shown as a muted line. No multi-field schedule form in
   the default path.
2. **Row anatomy** we should adopt: icon, title button, schedule line, hover
   actions (pause, edit, more). Keep the row a row, not a card.
3. **A filter chip** with a menu is enough for v1; no table, no sorting UI.
4. **Suggestions** as a collapsible block of one-line rows with a plus action.
5. **Do not copy** the reference's accessible-name duplication, the emoji
   artwork, or the personalized suggestions.

## Open questions

- What the task detail view looks like (not opened; would need a created task).
- Whether a task run appears in the chat transcript or in its own thread.
- What the filter menu offers ("active"/"paused"/"all"?).
- How a failed run is surfaced (the list shows only schedule state).
