/**
 * Catalog comparison shared by the drift gate and its tests.
 *
 * The gate treats the PO catalogs as the source of truth: every id must exist
 * in both locales, and every non-obsolete entry needs a non-empty translation.
 */
export interface CatalogParity {
  /** Ids present in the source locale but missing from the other locale. */
  missing: string[]
  /** Ids present in the other locale but not in the source locale. */
  extra: string[]
  /** Ids whose translation is empty or absent in either locale. */
  untranslated: string[]
}

export interface CatalogEntries {
  /** Id → translation. Obsolete entries must already be filtered out. */
  entries: Record<string, string>
}

export function compareCatalogs(
  source: CatalogEntries,
  target: CatalogEntries,
): CatalogParity {
  const sourceIds = Object.keys(source.entries).sort()
  const targetIds = Object.keys(target.entries).sort()
  const targetSet = new Set(targetIds)
  const sourceSet = new Set(sourceIds)
  return {
    missing: sourceIds.filter((id) => !targetSet.has(id)),
    extra: targetIds.filter((id) => !sourceSet.has(id)),
    untranslated: sourceIds
      .filter((id) => targetSet.has(id))
      .filter((id) => !source.entries[id] || !target.entries[id])
      .sort(),
  }
}

/** Human-readable drift lines; empty when the catalogs agree. */
export function parityProblems(locale: string, parity: CatalogParity): string[] {
  return [
    ...parity.missing.map((id) => `${locale}: missing message ${JSON.stringify(id)}`),
    ...parity.extra.map((id) => `${locale}: message ${JSON.stringify(id)} is not in the source locale`),
    ...parity.untranslated.map((id) => `${locale}: empty translation for ${JSON.stringify(id)}`),
  ]
}
