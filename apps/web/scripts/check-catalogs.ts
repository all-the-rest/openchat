/**
 * Catalog drift gate.
 *
 * Fails when a message exists in the source locale but not in German (or the
 * other way round), when a translation is empty, or when a committed compiled
 * bundle no longer matches a fresh render of its PO file.
 *
 * Invoked by `scripts/lint-i18n.ts` in gate mode, so `pnpm run lint` and
 * `gates:fast` cover it without a new ratchet rule.
 */
import { inspectCatalogs, staleProblems } from "./catalogs.ts"

const report = await inspectCatalogs()
const problems = [...report.problems, ...staleProblems(report)]

if (problems.length > 0) {
  console.error("i18n catalog drift:")
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

const total = report.locales[0] ? Object.keys(report.locales[0].entries.entries).length : 0
console.log(`i18n: ${report.locales.length} catalogs in parity (${total} messages)`)
