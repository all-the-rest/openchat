import type { ModelInfo } from "@openchat/contracts"

/** One browser key holds the whole favourite list, never one key per star. */
export const FAVORITES_STORAGE_KEY = "openchat.modelFavorites"

export interface ModelFavorite {
  model: string
  /** `null` stars the model itself; a string stars one of its variants. */
  variant: string | null
}

/** Stable identity: a model and each of its variants star separately. */
export function favoriteKey(favorite: ModelFavorite): string {
  return favorite.variant === null ? favorite.model : `${favorite.model}::${favorite.variant}`
}

/** Reads and validates the persisted list, dropping malformed and duplicate rows. */
export function readFavorites(): ModelFavorite[] {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const result: ModelFavorite[] = []
    for (const entry of value) {
      if (entry === null || typeof entry !== "object") continue
      const record = entry as Record<string, unknown>
      if (typeof record.model !== "string" || record.model.length === 0) continue
      const variant = typeof record.variant === "string" && record.variant ? record.variant : null
      const favorite: ModelFavorite = { model: record.model, variant }
      const key = favoriteKey(favorite)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(favorite)
    }
    return result
  } catch {
    return []
  }
}

/** Best effort: private browsing may refuse storage without failing the UI. */
export function writeFavorites(favorites: readonly ModelFavorite[]): void {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites))
  } catch {
    // The in-memory list still applies to this tab.
  }
}

/** A favourite is stale when its model (or its variant) left the catalogue. */
export function isStaleFavorite(
  favorite: ModelFavorite,
  models: readonly ModelInfo[],
): boolean {
  const model = models.find((entry) => entry.id === favorite.model)
  if (!model) return true
  return favorite.variant !== null && !model.variants.includes(favorite.variant)
}
