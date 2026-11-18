# 15 — i18n on Lingui

**Status:** 2026-11-18. Implements issue #30 (milestone v2.0): move the UI
strings to Lingui without touching the call sites. Spec:
[`../spec/12-i18n.md`](../spec/12-i18n.md).

## Why Lingui

The hand-written catalogue (two flat `Record<MessageKey, string>` files and a
`{name}` substituter) worked while the app was one screen deep, but it owned
three jobs that a real i18n layer should own: message extraction, ICU
formatting, and the compiled catalog format. Lingui 6 splits those cleanly,
keeps explicit message ids, and ships a compiler that turns PO files into
lookup tables. The UI keeps its typed `t()` API, so no component changed.

Chosen versions (all `^6.12.0`, one major, one release line):

| Package | Why this one |
| --- | --- |
| `@lingui/core` | Runtime `I18n` class; `_(id, values)` is the call the wrapper needs |
| `@lingui/react` | `I18nProvider`/`useLingui`; subscribes to `i18n` changes so `<Trans>` would re-render on a locale switch |
| `@lingui/cli` | `lingui extract` plus `createCompiledCatalog`, the compiler the Vite plugin also uses |
| `@lingui/format-po` | Lingui 6 moved gettext out of the CLI into a formatter package |
| `@lingui/vite-plugin` | Declares `vite ^8` support. Vite here is 8.3.8 (Rolldown); the plugin runs macros through `@lingui/native-tools`, so no Babel/SWC plugin or extra dependencies are needed |

React is 19.3, inside `@lingui/react`'s `^19` peer range. Node is 24+ (the
`>=22.19` engine requirement of the Lingui 6 packages is met).

## Catalog layout

```
apps/web/
  lingui.config.ts                 source locale en, locales [en, de], PO formatter
  src/i18n/messages/en.ts          barrel: spreads the feature maps, exports MessageKey
  src/i18n/messages/*.ts           English msg({ id, message }) descriptors by feature
  src/locales/en/messages.po       source catalog, msgstr filled with English
  src/locales/de/messages.po       German translations (verbatim from the old catalog)
  src/locales/en/messages.ts       committed compiled bundle (generated)
  src/locales/de/messages.ts       committed compiled bundle (generated)
```

Message ids are explicit and identical to the old keys
(`msg({ id: "apps.description", message: "…" })`), so every
`t("apps.description")` call site, every `MessageKey` in a lookup map, and every
English assertion in the component tests stayed valid. `MessageKey` is
`keyof typeof messages` over the descriptor barrel; the feature files are split
only to keep each source file small (the largest is 63 lines), not to change the
flat key space.

The German strings were migrated verbatim, including the typographic quotes in
`search.noResults`/`search.resultCount`. All 229 keys had a translation; none
was missing and none is empty.

## The `t()` compatibility layer

`src/i18n/index.ts` builds one `I18n` instance per locale over the compiled
bundles. `translate(locale, key, vars)` is `getI18n(locale)._(key, vars)`;
`provider.tsx` hands `getI18n(locale)` to Lingui's `I18nProvider` and rebuilds
its context value when the locale changes. `t` is therefore a thin wrapper over
`i18n._`, and `useI18n().t` / `useT()` keep their old signatures:

```tsx
const t = useT()
t("search.groupCount", { count: 3 }) // "3 found" / "3 gefunden"
```

The provider still owns persistence (`openchat.locale`), the
stored → `navigator.language` → English resolution, and `<html lang>`. Because
the active instance is swapped rather than mutated, the first paint already
uses `initialLocale`, and no activation happens during render.

## Extraction and compilation

```sh
pnpm --filter @openchat/web i18n:extract   # lingui extract --clean
pnpm --filter @openchat/web i18n:compile   # node scripts/compile-catalogs.ts
```

`i18n:extract` reads the `msg()` descriptors under `src/i18n/messages` and
writes both PO files. The source-locale catalog gets the English message as its
`msgstr`, so the compiled English bundle never falls back to raw ids.

**The compiled output is committed.** `pnpm build` and `pnpm test` then need no
pre-step, and a checkout is known-good without running the CLI. (The Vite plugin
can also compile PO imports on the fly, but that would push catalog compilation
into every test run and require a `*.po` module declaration for `tsc`.) The
compile script calls Lingui's own `createCompiledCatalog` with the same
TypeScript namespace as `lingui.config.ts`; its bytes are identical to
`lingui compile`, which keeps the gate truthful if someone runs the CLI instead.

`vite.config.ts` loads `lingui({ macroTransform: true })`. No component uses a
Lingui macro today, so the transform is inert in the bundle; it is configured so
a future `<Trans>` or `msg` in a component needs no build change.

## Drift gate

`scripts/lint-i18n.ts` still scans for literal UI strings. In gate mode it now
also runs `apps/web/scripts/check-catalogs.ts`, which:

1. reads both PO catalogs,
2. fails when an id exists only in `en` or only in `de`,
3. fails when a shared id has an empty translation,
4. re-renders both bundles in memory and fails when the committed `messages.ts`
   differs, naming the file and the `i18n:compile` command.

The check is part of `pnpm run lint`, so `gates:fast` and CI's fast job cover it.
The ratchet's `i18n-literals` rule still calls `node scripts/lint-i18n.ts
--count`; that mode stays a pure literal count (the catalog check is skipped),
so no new rule and no baseline change were needed. Fixture runs with `--target`
skip the catalog check as well, because their temporary tree has no catalogs.

The scanner was extended for Lingui's own components: text inside `<Trans>`,
`<Plural>`, `<Select>` and `<SelectOrdinal>` is translated, not hard-coded, so
those ranges are exempt (including nested markup such as
`<Trans>Hello <strong>world</strong></Trans>`). A literal elsewhere on the page
is still reported; two tests in `apps/server/test/i18n-lint.test.ts` pin both
halves.

## Adding a string

1. Add `"feature.key": msg({ id: "feature.key", message: "English" })` to the
   matching `src/i18n/messages/*.ts` file.
2. Run `pnpm --filter @openchat/web i18n:extract`; the new id appears in both PO
   files. Put the German text in `src/locales/de/messages.po` (`msgstr`).
3. Run `pnpm --filter @openchat/web i18n:compile`.
4. Use `t("feature.key")` in the component. Never write the literal in JSX.

The drift gate fails at step 2/3 if either catalog or the compiled bundle is out
of date.

## Deliberately not converted

The slice stops at catalogs, extraction, compilation and locale switching. It
does **not** rewrite call sites to `msg`/`<Trans>`:

- Every current string interpolates with `{name}` placeholders, which
  `i18n._(id, vars)` formats through ICU. No `<Trans>` is required for
  interpolation; adding one would be churn without behaviour.
- Components read their labels through lookup maps (`Record<Phase, MessageKey>`,
  error-code maps) whose types depend on `MessageKey`. Macros return descriptors,
  not keys, so a wholesale conversion would ripple through those maps for no
  user-visible gain.
- `<Trans>` remains available and the provider is wired for it. The documented
  rule is: use `<Trans>` only when a message needs rich text (embedded links or
  markup) that a plain string cannot express.

Plurals are the same story: the current German and English strings have no
plural forms, so no `plural()`/`<Plural>` was introduced. The message format
already supports them when a string needs it.

## Tests

- Existing component tests are unchanged and still assert English strings.
- `test/i18n.test.tsx` covers catalog equality, no raw keys, a locale switch
  that re-renders both locales and updates `<html lang>`, and interpolation with
  vars (including a numeric count).
- `test/i18n-catalog-parity.test.ts` feeds `compareCatalogs` synthetic catalogs
  to prove the gate fails on a missing `de` key, an extra `de` key and an empty
  translation, and passes on matching catalogs. One end-to-end case writes a
  temporary PO pair and asserts `inspectCatalogs` reports the missing `de` key;
  another checks that a missing or modified compiled bundle is reported.
- `apps/server/test/i18n-lint.test.ts` proves the literal scanner still catches
  hard-coded JSX and now exempts Lingui component children.
