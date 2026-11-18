/**
 * `i18n:compile` — renders the committed Lingui bundles.
 *
 * Uses Lingui's compiler (`createCompiledCatalog`) with the same TypeScript
 * namespace as `lingui.config.ts`, so the output matches `lingui compile` while
 * giving the drift gate a deterministic function to compare against.
 */
import { writeFileSync } from "node:fs"
import { inspectCatalogs } from "./catalogs.ts"

const report = await inspectCatalogs()
if (report.problems.length > 0) {
  console.error("i18n:compile: catalogs are not in parity, not writing output")
  for (const problem of report.problems) console.error(`  ${problem}`)
  process.exit(1)
}

for (const catalog of report.locales) {
  writeFileSync(catalog.compiledPath, catalog.compiled)
  console.log(`wrote ${catalog.compiledPath}`)
}
