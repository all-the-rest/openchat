import { contextTokens } from "@openchat/contracts"
import type { CompactionOutcome, PromptNotice, SessionContext } from "@openchat/contracts"
import type { ChatBackend } from "@openchat/opencode"

/** How long a prompt waits for the host's terminal compaction event. */
export const COMPACTION_WAIT_MS = 20_000

/** Why a prompt was admitted with or without an automatic compaction. */
export type SoftCapReason =
  | "off"
  | "unknown"
  | "below"
  | "streaming"
  | "repeat"
  | "ended"
  | "failed"
  | "timeout"

export interface SoftCapDecision {
  compacted: boolean
  reason: SoftCapReason
  /** Set when the owner needs a notice: a successful or a failed compaction. */
  notice?: PromptNotice
}

export interface ContextSoftCapOptions {
  backend: Pick<ChatBackend, "sessionContext" | "compact">
  /** Tokens at which the guard compacts; `0` turns it off. */
  cap: number
  /** Bounded wait for compaction; tests shorten it. */
  waitMs?: number
}

/**
 * The BFF-side soft cap (issue #53). The host already compacts on its own
 * buffer, but a host that idles at 80% of a large window still sends the whole
 * context once the prompt arrives. This gate prices that in before admission:
 * at or over the cap, on an idle session, it asks for one compaction, waits
 * for the terminal event and then lets the prompt through.
 *
 * A failed or timed-out compaction never blocks the turn. The last attempted
 * usage level is remembered so the same context is not compacted twice in a
 * row; only new tokens (a higher reported usage) permit another attempt.
 */
export class ContextSoftCap {
  private readonly lastAttempt = new Map<string, number>()
  private readonly waitMs: number

  constructor(private readonly options: ContextSoftCapOptions) {
    this.waitMs = options.waitMs ?? COMPACTION_WAIT_MS
  }

  async admit(sessionID: string): Promise<SoftCapDecision> {
    if (this.options.cap <= 0) return { compacted: false, reason: "off" }

    let context: SessionContext
    try {
      context = await this.options.backend.sessionContext(sessionID)
    } catch {
      // An unreadable session must not stop the prompt; the host policy still
      // applies to the turn itself.
      return { compacted: false, reason: "unknown" }
    }
    if (!context.usage) return { compacted: false, reason: "unknown" }

    const used = contextTokens(context.usage)
    if (used < this.options.cap) return { compacted: false, reason: "below" }
    if (context.streaming) return { compacted: false, reason: "streaming" }

    const previous = this.lastAttempt.get(sessionID)
    if (previous !== undefined && used <= previous) {
      return { compacted: false, reason: "repeat" }
    }
    // Remember the attempt before awaiting the host, so a second prompt that
    // races the first cannot start a parallel compaction at the same level.
    this.lastAttempt.set(sessionID, used)

    let outcome: CompactionOutcome
    try {
      outcome = await this.options.backend.compact(sessionID, {
        id: `msg_softcap_${sessionID}_${used}`,
        waitMs: this.waitMs,
        reason: "auto",
      })
    } catch {
      return { compacted: false, reason: "failed", notice: "contextCompactionFailed" }
    }

    if (outcome.status === "ended") {
      return { compacted: true, reason: "ended", notice: "contextCompacted" }
    }
    if (outcome.status === "failed") {
      return { compacted: false, reason: "failed", notice: "contextCompactionFailed" }
    }
    if (outcome.status === "timeout") {
      return { compacted: false, reason: "timeout", notice: "contextCompactionFailed" }
    }
    // The host accepted but did not answer in time in a mode that asked it to;
    // that is the same warning as a timeout for the owner.
    return { compacted: false, reason: "timeout", notice: "contextCompactionFailed" }
  }
}
