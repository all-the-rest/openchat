export type PaletteAction =
  | "newChat"
  | "chat"
  | "settings"
  | "apps"
  | "artifacts"
  | "code"
  | "theme"
  | "language"
  | "copyAnswer"

export interface PaletteItem {
  /** Stable within one render; also the DOM option id. */
  id: string
  kind: "action" | "chat"
  label: string
  /** A matched snippet for a chat, or a short reason an action is unavailable. */
  hint?: string
  action?: PaletteAction
  sessionID?: string
  /** Kept visible but skipped by the keyboard, e.g. copy with no answer. */
  disabled?: boolean
}

export interface ChatCandidate {
  sessionID: string
  title: string
  snippet?: string
  /** How recent entries are ordered; ignored for real search hits. */
  updated?: number
}

export const RECENT_LIMIT = 6

function matches(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.toLowerCase())
}

/**
 * The palette's flat option order:
 *
 * - empty query: every action, then the most recently updated chats;
 * - a query: matching actions, then chat hits from `/api/search`.
 *
 * Only labels and already-computed snippets are shown; a transcript body is
 * never forwarded to the palette.
 */
export function composeItems(
  query: string,
  actions: readonly PaletteItem[],
  hits: readonly ChatCandidate[],
  recents: readonly ChatCandidate[],
): PaletteItem[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    const recentItems = [...recents]
      .sort((left, right) => (right.updated ?? 0) - (left.updated ?? 0))
      .slice(0, RECENT_LIMIT)
      .map<PaletteItem>((chat) => ({
        id: `recent-${chat.sessionID}`,
        kind: "chat",
        label: chat.title,
        sessionID: chat.sessionID,
      }))
    return [...actions, ...recentItems]
  }

  const matchingActions = actions.filter((item) => matches(item.label, trimmed))
  const searchItems = hits.map<PaletteItem>((hit, index) => ({
    id: `chat-${hit.sessionID}-${index}`,
    kind: "chat",
    label: hit.title,
    hint: hit.snippet,
    sessionID: hit.sessionID,
  }))
  return [...matchingActions, ...searchItems]
}

/**
 * Moves the active option by `delta`, wrapping at either end and skipping
 * options the palette keeps visible but cannot run (copy without an answer).
 */
export function nextActive(
  items: readonly PaletteItem[],
  activeID: string | null,
  delta: number,
): string | null {
  const enabled = items.filter((item) => !item.disabled)
  if (enabled.length === 0) return null
  const current = enabled.findIndex((item) => item.id === activeID)
  if (current === -1) return enabled[0]?.id ?? null
  const next = (current + delta + enabled.length) % enabled.length
  return enabled[next]?.id ?? null
}

/** `Home`/`End` land on the first or last runnable option. */
export function edgeActive(items: readonly PaletteItem[], last: boolean): string | null {
  const enabled = items.filter((item) => !item.disabled)
  return (last ? enabled.at(-1) : enabled[0])?.id ?? null
}
