/**
 * Lingui catalog plumbing for the committed compiled bundles.
 *
 * The PO catalogs under `src/locales` are the source of truth. `i18n:compile`
 * renders them with Lingui's own compiler into `messages.ts`; the drift gate
 * renders the same bytes in memory and compares them with what is committed,
 * so stale output fails before it can ship.
 *
 * Paths default to the web app root (`process.cwd()` for the `i18n:*` scripts
 * and for the root lint gate that spawns the checker); tests pass a fixture
 * directory instead.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createCompiledCatalog, getFormat } from "@lingui/cli/api"
import {
  compareCatalogs,
  parityProblems,
  type CatalogEntries,
  type CatalogParity,
} from "./catalog-parity.ts"

export const LOCALES = ["en", "de"] as const
export type CatalogLocale = (typeof LOCALES)[number]

export const SOURCE_LOCALE: CatalogLocale = "en"

export interface LocaleCatalog {
  locale: CatalogLocale
  entries: CatalogEntries
  /** Rendered `messages.ts` content, byte-for-byte what the compiler emits. */
  compiled: string
  /** Committed compiled bundle this catalog is compared against. */
  compiledPath: string
}

export function catalogPath(locale: CatalogLocale, baseDir = process.cwd()): string {
  return join(baseDir, "src/locales", locale, "messages.po")
}

export function compiledPath(locale: CatalogLocale, baseDir = process.cwd()): string {
  return join(baseDir, "src/locales", locale, "messages.ts")
}

/** Reads one PO catalog, dropping obsolete entries. */
async function readEntries(locale: CatalogLocale, baseDir: string): Promise<CatalogEntries> {
  const format = await getFormat(undefined, SOURCE_LOCALE)
  const catalog = await format.read(catalogPath(locale, baseDir), locale)
  const entries: Record<string, string> = {}
  if (!catalog) return { entries }
  for (const [id, entry] of Object.entries(catalog)) {
    if (entry.obsolete) continue
    entries[id] = entry.translation ?? ""
  }
  return { entries }
}

function render(locale: CatalogLocale, entries: CatalogEntries): string {
  const { source, errors } = createCompiledCatalog(locale, entries.entries, {
    namespace: "ts",
  })
  if (errors.length > 0) {
    const detail = errors.map((error) => `${error.id}: ${error.error.message}`).join("\n")
    throw new Error(`catalog ${locale} does not compile:\n${detail}`)
  }
  return source
}

export async function loadCatalog(
  locale: CatalogLocale,
  baseDir = process.cwd(),
): Promise<LocaleCatalog> {
  const entries = await readEntries(locale, baseDir)
  return {
    locale,
    entries,
    compiled: render(locale, entries),
    compiledPath: compiledPath(locale, baseDir),
  }
}

export interface CatalogReport {
  locales: LocaleCatalog[]
  parity: Map<CatalogLocale, CatalogParity>
  problems: string[]
}

/** Reads every locale and reports parity problems. */
export async function inspectCatalogs(baseDir = process.cwd()): Promise<CatalogReport> {
  const locales = await Promise.all(LOCALES.map((locale) => loadCatalog(locale, baseDir)))
  const source = locales.find((catalog) => catalog.locale === SOURCE_LOCALE)
  if (!source) throw new Error(`source locale ${SOURCE_LOCALE} is not configured`)
  const parity = new Map<CatalogLocale, CatalogParity>()
  const problems: string[] = []
  for (const catalog of locales) {
    const result = compareCatalogs(source.entries, catalog.entries)
    parity.set(catalog.locale, result)
    if (catalog.locale !== SOURCE_LOCALE) {
      problems.push(...parityProblems(catalog.locale, result))
    }
  }
  return { locales, parity, problems }
}

/** Problems where the committed compiled file differs from a fresh render. */
export function staleProblems(report: CatalogReport): string[] {
  return report.locales.flatMap((catalog) => {
    let committed: string
    try {
      committed = readFileSync(catalog.compiledPath, "utf8")
    } catch {
      return [
        `${catalog.locale}: ${catalog.compiledPath} is missing; run \`pnpm --filter @openchat/web i18n:compile\``,
      ]
    }
    return committed === catalog.compiled
      ? []
      : [
          `${catalog.locale}: ${catalog.compiledPath} is stale; run \`pnpm --filter @openchat/web i18n:compile\``,
        ]
  })
}
