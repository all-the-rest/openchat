# 31 — Subagent sessions: parent link and grouped sidebar

**Status:** 2026-11-18. Implements issue #55 (part of the agent/tasks epic, #7).
Source of truth for the feature is our own contract plus the pinned
`@opencode/client` type (`SessionInfo.parentID`); no reference code or UI text
was used.

## What ships

| Layer | Change |
| --- | --- |
| Contract | `SessionInfo.parentID?: string` — set only when the host reports it |
| Live mapping | `normalizeSession` copies `parentID`; an absent host field stays absent (the key is not added as `undefined`) |
| Fake backend | `seedSubagents: true` (the fake BFF sets it) seeds one deterministic pair |
| Sidebar | one nesting level, collapsed by default, persisted per browser |
| Links | child rows show the parent title; the chat header links back to the parent |
| i18n | five `en`/`de` keys (count, expand/collapse, agent badge, parent context, back link) |

## Seeded fake pair

With `seedSubagents: true` the fake backend returns:

- `ses_subagent_parent`, title "Quarterly report review";
- `ses_subagent_child`, title "Agent: check the figures", `parentID` set to the
  parent. Both carry a finished turn, so the nested sidebar, the back link and
  the E2E subagent spec run without a live host.

The fake is a **state fixture**, not a scheduler: nothing creates children at
runtime, because only the host owns parent links.

## Grouping rules

`groupSessions` builds exactly one visual level:

- a root is a session whose `parentID` is absent or points to a session that is
  not in the list (orphan);
- a child is nested under its root; a grandchild (parent is itself a child) is
  reparented to the same root instead of creating a second level;
- no session appears twice, and the root order follows the host's list order.

Collapse state lives under `openchat.sidebar.expanded` and is read through a
small storage helper so tests can round-trip it without a browser.

## Deliberate omissions

- No `parentID` parameter on session creation: the host remains the owner of
  parent links.
- A deep link to a collapsed child does not auto-expand the group.
- No live-host E2E; the mapping is covered by the normalizer and BFF tests.

## Tests

`packages/opencode/test/fixture.test.ts` (parent kept, absent key stays absent),
`fake.test.ts` (pair determinism), `apps/server/test/sessions.test.ts` (BFF
mapping), `apps/web/test/session-groups.test.ts` (grouping, orphan, grandchild,
storage), `sidebar-subagents.test.tsx` (collapse default, keyboard toggle and
`aria-expanded`, persisted remount, orphan badge), `chat-session.test.tsx`
(back link), and `apps/web/e2e/subagents.spec.ts` (end-to-end with the fake).
