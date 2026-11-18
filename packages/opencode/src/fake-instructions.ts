/**
 * Instruction-entry storage for the fake backend. The live host keeps these
 * per session and announces changes at the next step boundary; the fake only
 * needs to record what the BFF put, including the host's size cap.
 */
export class FakeInstructions {
  private readonly bySession = new Map<string, Map<string, string>>()

  put(sessionID: string, key: string, value: string, maxBytes?: number): void {
    const actualBytes = Buffer.byteLength(value, "utf8")
    if (maxBytes !== undefined && actualBytes > maxBytes) {
      throw {
        _tag: "InstructionEntryValueTooLargeError",
        actualBytes,
        maxBytes,
        message: "instruction entry is too large",
      }
    }
    const entries = this.bySession.get(sessionID) ?? new Map<string, string>()
    entries.set(key, value)
    this.bySession.set(sessionID, entries)
  }

  entries(sessionID: string): Record<string, string> | null {
    const entries = this.bySession.get(sessionID)
    return entries ? Object.fromEntries(entries) : null
  }
}
