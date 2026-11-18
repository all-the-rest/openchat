import type { SessionInfo } from "@openchat/contracts"

/** Per-browser expansion of the subagent groups in the sidebar. */
export const EXPANDED_SESSIONS_STORAGE_KEY = "openchat.sidebar.expanded"

export interface SessionGroup {
  /** The chat rendered at the top level; children hang below it. */
  session: SessionInfo
  /** Direct and reparented descendants, in list order. */
  children: SessionInfo[]
  /** True when the root's parent is not part of the list. */
  orphan: boolean
}

function rootOf(session: SessionInfo, byID: ReadonlyMap<string, SessionInfo>): SessionInfo {
  let current = session
  const seen = new Set<string>()
  while (true) {
    if (seen.has(current.id)) return session
    seen.add(current.id)
    const parent = current.parentID ? byID.get(current.parentID) : undefined
    if (!parent) return current
    current = parent
  }
}

/**
 * Builds one level of nesting: every session appears exactly once. A child
 * whose parent is missing stays at the top with `orphan` set; a deeper
 * descendant is attached to the nearest visible ancestor instead of vanishing.
 */
export function groupSessions(sessions: readonly SessionInfo[]): SessionGroup[] {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const roots = sessions.filter((session) => rootOf(session, byID).id === session.id)
  const groups = new Map<string, SessionGroup>(
    roots.map((root) => [
      root.id,
      {
        session: root,
        children: [],
        orphan: root.parentID !== undefined && !byID.has(root.parentID),
      },
    ]),
  )

  for (const session of sessions) {
    const root = rootOf(session, byID)
    if (root.id !== session.id) groups.get(root.id)?.children.push(session)
  }

  return roots.map((root) => groups.get(root.id) as SessionGroup)
}

export function readExpandedSessions(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(EXPANDED_SESSIONS_STORAGE_KEY)
    if (!raw) return new Set()
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((entry): entry is string => typeof entry === "string"))
  } catch {
    return new Set()
  }
}

/** Best effort: private browsing may refuse storage without failing the UI. */
export function writeExpandedSessions(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_SESSIONS_STORAGE_KEY, JSON.stringify([...ids].sort()))
  } catch {
    // The in-memory expansion still applies to this tab.
  }
}
