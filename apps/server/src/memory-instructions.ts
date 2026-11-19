import { MEMORY_INDEX_KEY } from "@openchat/contracts"
import type { createMemoryStore } from "./memory-store"

/** Active sessions are a hint for re-puts, not durable state. */
export const MAX_ACTIVE_MEMORY_SESSIONS = 512

type MemoryStore = ReturnType<typeof createMemoryStore>

/** The narrow port another builder added to `ChatBackend`. */
export interface MemoryInstructionTarget {
  putInstruction(sessionID: string, key: string, value: string): Promise<void>
  /** Optional: recovers sessions that pre-date a BFF restart. */
  listSessions?(): Promise<ReadonlyArray<{ id: string }>>
}

/** Accepts a single port or a list; anything else silently disables re-puts. */
function targetsFrom(backends: unknown): MemoryInstructionTarget[] {
  const list = Array.isArray(backends) ? backends : [backends]
  return list.filter(
    (item): item is MemoryInstructionTarget =>
      typeof item === "object" && item !== null &&
      typeof (item as { putInstruction?: unknown }).putInstruction === "function",
  )
}

/**
 * Sessions are tracked once per process, shared by the internal and public
 * registrars, so a mutation through either route re-puts into both sets.
 */
const activeSessions = new Set<string>()

export interface MemoryInvalidator {
  /**
   * Remembers a session created through the public route. It stays active for
   * later re-puts; the caller plants the initial index and calls
   * `markInjected` once the put succeeded.
   */
  noteSession(sessionID: string): void
  /** Notes that this session already received the initial index. */
  markInjected(sessionID: string): void
  /**
   * Plants the current index into every backend session that this BFF did not
   * create and that has no index yet. Code-UI and host-created sessions never
   * pass through `POST /api/sessions`, so this is their only entry point.
   *
   * `sessions` lets a caller that just listed them (the session route) reuse
   * its answer instead of paying a second list call.
   */
  discover(sessions?: ReadonlyArray<{ id: string }>): Promise<void>
  /** Re-puts the current index into every remembered session. */
  invalidate(): Promise<void>
  /** Active session count; exposed for tests. */
  readonly active: number
}

export function createMemoryInvalidator(
  backends: unknown, store: MemoryStore,
): MemoryInvalidator {
  const targets = targetsFrom(backends)
  /**
   * Sessions whose initial index was planted. Discovery skips them, so a
   * session created by the BFF is not injected a second time on the next pass.
   * Bounded like `activeSessions`: a very long-lived process evicts the oldest
   * entry and would re-plant that one on a later discovery, which keeps the
   * memory cost fixed without ever writing twice in the same pass.
   */
  const injected = new Set<string>()
  const note = (sessionID: unknown): void => {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    activeSessions.delete(sessionID)
    if (activeSessions.size >= MAX_ACTIVE_MEMORY_SESSIONS) {
      const oldest = activeSessions.values().next()
      if (!oldest.done) activeSessions.delete(oldest.value)
    }
    activeSessions.add(sessionID)
  }
  const rememberInjected = (sessionID: unknown): void => {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    injected.delete(sessionID)
    if (injected.size >= MAX_ACTIVE_MEMORY_SESSIONS) {
      const oldest = injected.values().next()
      if (!oldest.done) injected.delete(oldest.value)
    }
    injected.add(sessionID)
  }
  /**
   * A restart empties the module-level set, and Code-created sessions never
   * arrive through the create route at all. Reading the backend's session list
   * recovers both: every session without an index gets the current one, the
   * pass is bounded like the active set and a session is never planted twice.
   * Failures stay local to the host or store call and never fail the request.
   */
  const discover = async (
    sessions?: ReadonlyArray<{ id: string }>,
  ): Promise<void> => {
    if (targets.length === 0) return
    const seen = new Set<string>()
    const candidates: string[] = []
    const consider = (list: ReadonlyArray<{ id: string }>): void => {
      for (const session of list) {
        const sessionID = typeof session?.id === "string" ? session.id : ""
        if (sessionID.length === 0 || seen.has(sessionID) || injected.has(sessionID)) continue
        if (candidates.length >= MAX_ACTIVE_MEMORY_SESSIONS) return
        seen.add(sessionID)
        candidates.push(sessionID)
      }
    }
    if (sessions) {
      consider(sessions)
    } else {
      for (const target of targets) {
        if (typeof target.listSessions !== "function") continue
        try {
          consider(await target.listSessions())
        } catch { /* host */ }
      }
    }
    if (candidates.length === 0) return
    // Memory is a convenience: an unavailable store must not fail a session
    // list. The next pass retries.
    let index: string
    try {
      index = store.index().index
    } catch { /* store */ return }
    await Promise.all(candidates.flatMap((sessionID) =>
      targets.map(async (target) => {
        try {
          await target.putInstruction(sessionID, MEMORY_INDEX_KEY, index)
          note(sessionID)
          rememberInjected(sessionID)
        } catch { /* host */ }
      })))
  }
  return {
    noteSession(sessionID) {
      note(sessionID)
    },
    markInjected(sessionID) {
      rememberInjected(sessionID)
    },
    async discover(sessions) {
      await discover(sessions)
    },
    async invalidate() {
      if (targets.length === 0) return
      // Sessions known before this pass get the refreshed index. Sessions
      // discovered now just received it, so they are not written twice.
      const known = new Set(activeSessions)
      await discover()
      const refresh = [...activeSessions].filter((sessionID) => known.has(sessionID))
      if (refresh.length === 0) return
      const { index } = store.index()
      await Promise.all(targets.flatMap((target) =>
        refresh.map(async (sessionID) => {
          try { await target.putInstruction(sessionID, MEMORY_INDEX_KEY, index) } catch { /* host */ }
        })))
    },
    get active() { return activeSessions.size },
  }
}
