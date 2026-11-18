# 32 — Model selector: variants, capabilities and favorites

**Status:** 2026-11-18. Implements issue #51. The source of truth is our own
contract plus the pinned `@opencode/client` model catalogue; no reference UI
text or code was used.

## What ships

| Layer | Change |
| --- | --- |
| Contract | `ModelInfo` gains `providerName`, `variants`, `contextLimit`, `capabilities` (`input`/`output`) and `status` |
| Prompt | `PromptInput.variant` is validated and forwarded with the model |
| Live mapping | `mapHostModel` reads `providerName`, `variants`, `limit.context`, `capabilities` and `status`; an unknown variant is dropped before it reaches the host |
| Fake catalogue | two providers, a two-variant model and one deprecated model, so the picker's grouping and badges are visible in fake mode |
| Picker | provider groups, search, capability and context badges, variant submenu, per-browser favorites |
| Settings | the same picker serves the settings page, so favorites pin there too |

## Identity

A model is `providerID/modelID`; a variant is a separate starrable choice.
`modelKey`-style identity is `provider + model + variant`, so starring `fast`
and `thorough` of the same model yields two entries.

## Favorites

One browser key (`openchat.modelFavorites`) holds the whole list. Reads
validate every row and drop malformed or duplicate entries; writes are
best-effort, because private browsing may refuse storage without failing the
UI. A favorite whose model or variant is no longer in the catalogue is **stale**
and is never sent: the request silently uses the default model instead of
forwarding a vanished identifier.

## Deliberate omissions

- Cost and PDF-input capability are not part of the contract yet.
- The choice is one browser-wide default applied before each prompt; there is
  no per-chat override and no drag reordering.
- Favorites are read on mount, not live-synced across tabs.
- The switch map stays keyed by `modelID`; two providers exposing the same model
  id would collide (pre-existing).
- A vanished model that is selected but not favorited falls back to "Default"
  without a stale row.

## Tests

`packages/opencode/test/completion.test.ts` (mapping, metadata, variant
forwarding, unknown variant dropped), `apps/server/test/completion.test.ts`
(catalogue and prompt forwarding), `apps/web/test/model-picker.test.tsx`
(grouping, search, variants, keyboard, favorites, stale favorite),
`completion.test.tsx` (send path, stale favorite never sent),
`settings-page.test.tsx` (shared picker), and `apps/web/e2e/completion.spec.ts`
(variant recorded by the fake, favorites pinned and applied).
