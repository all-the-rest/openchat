import type { ChatBackend } from "@openchat/opencode"
import type { MemoryStore } from "@openchat/memory-store"

/**
 * Injection: the bounded INDEX.md becomes one instruction entry per session.
 * A new session gets it immediately; sessions seen since boot are refreshed
 * when memory changes. A too-large value is trimmed by rank (the index is
 * already ranked) instead of failing the session.
 */

export const MEMORY_INSTRUCTION_KEY = "memory/index"
const MAX_TRACKED_SESSIONS = 500

export interface MemoryServiceOptions {
  store: MemoryStore
  backend: ChatBackend
  /** Called once per injection that had to drop lines. */
  log?: (message: string) => void
}

function isValueTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const tag = (error as { _tag?: unknown })._tag
  const name = (error as { name?: unknown }).name
  return (
    tag === "InstructionEntryValueTooLargeError" ||
    (typeof tag === "string" && tag.includes("ValueTooLarge")) ||
    (typeof name === "string" && name.includes("ValueTooLarge"))
  )
}

export class MemoryService {
  readonly store: MemoryStore
  private readonly backend: ChatBackend
  private readonly log: (message: string) => void
  private readonly active = new Set<string>()

  constructor(options: MemoryServiceOptions) {
    this.store = options.store
    this.backend = options.backend
    this.log = options.log ?? ((message) => console.warn(`[openchat] ${message}`))
  }

  /** Records a session that may receive a refresh; oldest entries fall out. */
  track(sessionID: string): void {
    if (this.active.has(sessionID)) return
    this.active.add(sessionID)
    if (this.active.size <= MAX_TRACKED_SESSIONS) return
    const oldest = this.active.values().next().value
    if (typeof oldest === "string") this.active.delete(oldest)
  }

  async index(): Promise<string> {
    return await this.store.readIndex()
  }

  /** Puts the current index on one session, trimming only on the host cap. */
  async inject(sessionID: string): Promise<void> {
    let lines = (await this.index()).split("\n")
    // The trailing newline becomes an empty element; keep the real lines only.
    if (lines.at(-1) === "") lines = lines.slice(0, -1)
    let dropped = 0
    for (let attempt = 0; attempt <= 64; attempt += 1) {
      try {
        await this.backend.putSessionInstruction(
          sessionID,
          MEMORY_INSTRUCTION_KEY,
          `${lines.join("\n")}\n`,
        )
        if (dropped > 0) {
          this.log(`memory: trimmed ${dropped} index line(s) for ${sessionID}`)
        }
        return
      } catch (error) {
        if (!isValueTooLarge(error) || lines.length <= 2) throw error
        // Ranked order: the last fact line is the least important one.
        lines = lines.slice(0, -1)
        dropped += 1
      }
    }
  }

  /** Best effort: one unreachable session must not stop the others. */
  async refresh(): Promise<{ refreshed: number; failed: number }> {
    let refreshed = 0
    let failed = 0
    for (const sessionID of [...this.active]) {
      try {
        await this.inject(sessionID)
        refreshed += 1
      } catch {
        failed += 1
      }
    }
    return { refreshed, failed }
  }
}
