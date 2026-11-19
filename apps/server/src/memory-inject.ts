/**
 * Per-session injection of the bounded memory index. The BFF owns this because
 * the host has no memory API: on session creation it puts `memory/index` through
 * the backend port, and it re-puts the same key on active sessions whenever the
 * store changes. Values are trimmed by rank, never cut mid-sentence, so a
 * `ValueTooLargeError` shrinks the block instead of failing the session.
 */
import type { ChatBackend } from "@openchat/opencode"
import { isInstructionTooLarge } from "@openchat/opencode"
import type { MemoryStore } from "@openchat/memory-store"

export const MEMORY_INDEX_KEY = "memory/index"

/** Local ceiling below the host's default; the host cap still wins if lower. */
export const MEMORY_INDEX_LOCAL_MAX_BYTES = 32 * 1024

export interface MemoryInjectorOptions {
  backend: ChatBackend
  store: MemoryStore
  maxBytes?: number
}

export class MemoryInjector {
  private readonly active = new Set<string>()
  private trims = 0

  constructor(private readonly options: MemoryInjectorOptions) {}

  /** Tracks a new session and injects the current index into it. */
  async inject(sessionID: string): Promise<void> {
    this.active.add(sessionID)
    await this.put(sessionID)
  }

  /** Re-puts the index into every session created in this process. */
  async refreshAll(): Promise<number> {
    for (const sessionID of this.active) await this.put(sessionID)
    return this.active.size
  }

  activeSessions(): string[] {
    return [...this.active]
  }

  trimmedCount(): number {
    return this.trims
  }

  private async put(sessionID: string): Promise<void> {
    const text = await this.options.store.index()
    const capped = trim(text, this.options.maxBytes ?? MEMORY_INDEX_LOCAL_MAX_BYTES)
    try {
      await this.options.backend.putInstruction(sessionID, MEMORY_INDEX_KEY, capped)
    } catch (error) {
      if (!isInstructionTooLarge(error)) throw error
      this.trims += 1
      await this.options.backend.putInstruction(sessionID, MEMORY_INDEX_KEY, trim(capped, error.maxBytes))
    }
  }
}

/** Drops whole ranked lines from the end until the UTF-8 cap is met. */
export function trim(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const lines = text.split("\n")
  let out = lines[0] ?? "# Memory index"
  for (const line of lines.slice(1)) {
    const candidate = `${out}\n${line}`
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break
    out = candidate
  }
  return `${out}\n`
}
