# 13 — Shell menu: the app bar's overflow

**Status:** 2026-11-18. Implements issue #33 (milestone v2.0), the mobile half of
#10 that #11 left open. Spec: [`../spec/02-information-architecture.md`](../spec/02-information-architecture.md)
and [`../spec/13-code-surface.md`](../spec/13-code-surface.md). The surface
itself is described in [`07-code-ui.md`](./07-code-ui.md).

Spec 02 (header) and spec 13 (surface switch) promise that the Chat | Code
switch collapses into a header overflow menu below the wide breakpoint; spec 02
and spec 13 now describe the shipped behaviour.

## Why a menu

The v1 app bar carried the drawer toggle, the inline switch and the app name,
and the drawer carried Search and Apps. The switch therefore stayed visible on
phones, against the spec, and the navigation entries were two taps deep. The
overflow menu is the spec's answer: one trailing control that owns the switch
and the routes that belong to navigation rather than to a session.

The drawer keeps the session list. The menu never renders it, so a phone user
still has one place for chats and a shallow place for everything else.

## Contents, in order

| Entry | Rendered when | Action |
| --- | --- | --- |
| `Chat | Code` segmented control | `/api/info` reports `code.configured === true` | Reuses `SurfaceSwitch`: two real buttons with `aria-pressed`, choosing persists the surface and navigates (`/` or `/code`) |
| Search | always | `/search?scope=all`, the sidebar's target |
| Apps | `/api/info` reports `apps.available === true` | `/apps` |
| New chat | always | Creates a session through `useSessions().create()` and navigates to `/c/<id>`, exactly like the sidebar button |

With no Code host there is no surface entry; the menu still opens for Search,
Apps and New chat. A failed New chat (no session, host error) keeps the menu
open and shows the existing `session.createFailed` message as `role="alert"`
inside the panel.

Not in the menu: sessions, pin/archive actions, theme and language (drawer
footer), sign-out (drawer footer). The trigger is not a second route; the menu
has no URL.

## Breakpoint

`(min-width: 1024px)` — Tailwind's `lg`, the same query `AppShell` uses to turn
the sidebar into a drawer. At or above it, `AppBarMenu` returns `null` and the
inline `SurfaceSwitch` stays in the bar. Below it the inline switch is not
rendered at all, so exactly one surface control exists in the DOM:

| Route | Wide (`≥1024 px`) | Narrow (`<1024 px`) |
| --- | --- | --- |
| Chat routes | switch in the app bar | switch inside the menu |
| `/code` | switch in the Code bar | switch in the Code bar (the app bar is not rendered) |

The app bar below `lg` is: drawer toggle, name, menu trigger. That order keeps
the 320 px bar on one row with all three controls; `e2e/shell-menu.spec.ts`
asserts no horizontal scroll at that width.

## Accessibility contract

- **Trigger.** A `button` with `aria-haspopup="menu"`, `aria-expanded`,
  `aria-controls` pointing at the panel, and the localised name `menu.trigger`.
  The icon is `MoreIcon`, a three-dot ellipsis in the shared 1.8 px stroke
  style, 16 px at the `btn-sm` size.
- **Panel.** `role="menu"` with the localised label `menu.label`, anchored
  under the trigger. Search, Apps and New chat are `role="menuitem"`. The
  surface control stays a `role="group"` with two `aria-pressed` buttons — the
  same semantics as the inline switch — because a two-way toggle is not a
  single menu command.
- **Open.** Click, `Enter` and `Space` (native button activation) and
  `ArrowDown` on the trigger. Opening moves focus to the first menu item.
- **Close.** `Escape` closes and returns focus to the trigger; a `pointerdown`
  outside the trigger and panel closes it without moving focus; any navigation
  (a menu link, the surface choice, Back) closes it. The click on a menu link
  closes it before the route change, so the panel cannot survive a page swap.
- **Not a focus trap.** It is a menu, not a dialog: `Tab` and `Shift+Tab` leave
  it, and the panel is not inert while open.
- **Keyboard.** `ArrowDown`/`ArrowUp` move between menu items with wrap-around,
  `Home`/`End` jump to the first and last. Arrow keys pressed on the segmented
  control stay with that control; only real menu items take part in the roving
  focus.
- **Shortcut.** `Cmd/Ctrl+Shift+O` is unchanged and still toggles from
  anywhere, menu open or not.

## Strings

| Key | `en` | `de` |
| --- | --- | --- |
| `menu.trigger` | Open menu | Menü öffnen |
| `menu.label` | App menu | App-Menü |

Entries reuse `nav.search`, `nav.apps`, `nav.newChat`, `surface.label`,
`surface.chat` and `surface.code`. No literal UI text; `node
scripts/lint-i18n.ts` stays at zero findings.

## Tests

| File | Pins |
| --- | --- |
| `test/app-bar-menu.test.tsx` | absent at desktop, present at mobile; one switch per layout; click opens with `aria-expanded`; `Escape` closes and returns focus; outside `pointerdown` closes; `Tab` leaves (no trap); arrow/Home/End roving focus; surface entry only with a configured host; choosing Code persists and closes; Search/Apps navigate and close; Apps hidden without an app surface; New chat calls the same `create()` as the sidebar and navigates |
| `e2e/shell-menu.spec.ts` | at 390 px: the menu shows the switch and the three destinations, `Escape` closes with focus on the trigger; Apps lands on `/apps`; Chat/Code switches the surface and the panel is gone; at 320 px the bar keeps one row and the panel fits |
| `screenshots/ui-review.config.ts` | `shell-menu` route at `mobile` and `tablet`, opened through the trigger and gated by `waitForAppBarMenu` |

`test/code-surface.test.tsx` now asks for the wide viewport in its app-bar test,
because below `lg` the bar no longer owns the switch.

## Deliberate limits

- **The app bar has no theme controls.** The issue's context described a bar
  with theme controls; the shipped bar (and the drawer footer) put theme and
  language in the sidebar. The trigger therefore sits at the trailing edge
  after the name, where an overflow control belongs, rather than "where the
  theme controls live".
- **No menu on `/code`.** The Code surface renders no app bar; its slim bar
  carries the switch at every width, so the mobile menu has nothing to add
  there.
- **The header still opens the drawer, not Back.** Spec 02 describes "back,
  title and overflow" for a route stack; the v1 shell is a single drawer-based
  layout, so the leading control stays the drawer toggle and only the trailing
  overflow was added.
