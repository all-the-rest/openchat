/**
 * Chat drafts (spec 13: switching surfaces must not lose a prompt).
 *
 * Drafts live in `sessionStorage`, keyed by session id, so they survive a
 * route change and a reload of this tab but never leak into another tab or
 * another session. The helpers are pure aside from the injected storage.
 */
export const DRAFT_PREFIX = "openchat.draft."

export function draftStorageKey(sessionID: string): string {
  return `${DRAFT_PREFIX}${sessionID}`
}

function defaultStorage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readDraft(
  sessionID: string,
  storage: Storage | null = defaultStorage(),
): string {
  if (!sessionID || !storage) return ""
  try {
    return storage.getItem(draftStorageKey(sessionID)) ?? ""
  } catch {
    return ""
  }
}

/** An empty draft removes the entry instead of storing an empty string. */
export function writeDraft(
  sessionID: string,
  text: string,
  storage: Storage | null = defaultStorage(),
): void {
  if (!sessionID || !storage) return
  try {
    if (text.length === 0) storage.removeItem(draftStorageKey(sessionID))
    else storage.setItem(draftStorageKey(sessionID), text)
  } catch {
    // Storage is best effort; the composer keeps its in-memory value.
  }
}

export function clearDraft(
  sessionID: string,
  storage: Storage | null = defaultStorage(),
): void {
  if (!sessionID || !storage) return
  try {
    storage.removeItem(draftStorageKey(sessionID))
  } catch {
    // Ignore an unavailable storage partition.
  }
}
