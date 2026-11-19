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
  /** Remembers a session created through the public route. */
  noteSession(sessionID: string): void
  /** Re-puts the current index into every remembered session. */
  invalidate(): Promise<void>
  /** Active session count; exposed for tests. */
  readonly active: number
}

export function createMemoryInvalidator(
  backends: unknown, store: MemoryStore,
): MemoryInvalidator {
  const targets = targetsFrom(backends)
  const note = (sessionID: unknown): void => {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    activeSessions.delete(sessionID)
    if (activeSessions.size >= MAX_ACTIVE_MEMORY_SESSIONS) {
      const oldest = activeSessions.values().next()
      if (!oldest.done) activeSessions.delete(oldest.value)
    }
    activeSessions.add(sessionID)
  }
  /**
   * A restart empties the module-level set, so the first mutation would reach
   * no session. Reading the backend's list before the re-put restores the
   * sessions that already existed; the cap above keeps the set bounded.
   */
  const discover = async (): Promise<void> => {
    await Promise.all(targets.map(async (target) => {
      if (typeof target.listSessions !== "function") return
      try {
        for (const session of await target.listSessions()) note(session.id)
      } catch { /* host */ }
    }))
  }
  return {
    noteSession(sessionID) {
      note(sessionID)
    },
    async invalidate() {
      if (targets.length === 0) return
      await discover()
      if (activeSessions.size === 0) return
      const { index } = store.index()
      await Promise.all(targets.flatMap((target) =>
        [...activeSessions].map(async (sessionID) => {
          try { await target.putInstruction(sessionID, MEMORY_INDEX_KEY, index) } catch { /* host */ }
        })))
    },
    get active() { return activeSessions.size },
  }
}
