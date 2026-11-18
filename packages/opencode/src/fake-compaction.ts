import { EVENT } from "@openchat/contracts"
import type {
  CompactionOutcome,
  CompactionReason,
  SessionContext,
  TokenUsage,
} from "@openchat/contracts"
import type { CompactOptions } from "./index"
import { BackendError } from "./errors"

type Emit = (
  type: string,
  sessionID: string,
  data: Record<string, unknown>,
  durable: boolean,
) => unknown

/** What the fake-mode probe reports about one session's compactions. */
export interface CompactionRecord {
  count: number
  failures: number
  lastReason: CompactionReason | null
}

export interface FakeCompactionOptions {
  emit: Emit
  /** True while a scripted run is active; compaction is refused then. */
  isStreaming: (sessionID: string) => boolean
  /** Tokens one completed assistant turn reports. */
  usageTokens: number
  /** Id source for requests without an idempotency key. */
  nextID: () => string
}

const FAKE_SUMMARY = "Earlier conversation summarised by the fake backend."
const FAKE_FAILURE = "The fake summariser failed."

function tokensOf(input: number): TokenUsage {
  // Three distinct counters make the panel's rows provable in fake mode.
  return {
    input,
    output: Math.round(input / 3.6),
    reasoning: 0,
    cache: { read: Math.round(input / 2.4), write: 0 },
  }
}

/**
 * Token accounting and compaction scripting for the fake backend. Kept apart
 * from the session store so `fake.ts` stays readable and the behaviour is
 * testable without a transcript.
 */
export class FakeCompaction {
  private readonly lastUsage = new Map<string, number>()
  private readonly overrides = new Map<string, number>()
  private readonly failuresLeft = new Map<string, number>()
  private readonly records = new Map<string, CompactionRecord>()
  private readonly byId = new Map<string, CompactionOutcome>()

  constructor(private readonly options: FakeCompactionOptions) {}

  /** Usage one finished turn reports; also emits `session.usage.updated`. */
  noteRun(sessionID: string): TokenUsage {
    const usage = tokensOf(this.options.usageTokens)
    this.lastUsage.set(sessionID, this.options.usageTokens)
    this.options.emit(
      EVENT.usageUpdated,
      sessionID,
      { sessionID, cost: 0, tokens: usage },
      true,
    )
    return usage
  }

  /** Test hook: report this usage before any turn has finished. */
  /** The last report a finished turn made, for the session snapshot. */
  usageOf(sessionID: string): TokenUsage | undefined {
    const tokens = this.lastUsage.get(sessionID)
    return tokens === undefined ? undefined : tokensOf(tokens)
  }

  setUsage(sessionID: string, tokens: number): void {
    this.overrides.set(sessionID, tokens)
  }

  /** Test hook: make the next `times` compactions of this session fail. */
  failNext(sessionID: string, times = 1): void {
    this.failuresLeft.set(sessionID, Math.max(0, times))
  }

  record(sessionID: string): CompactionRecord {
    return this.records.get(sessionID) ?? { count: 0, failures: 0, lastReason: null }
  }

  context(sessionID: string): SessionContext {
    const tokens = this.overrides.get(sessionID) ?? this.lastUsage.get(sessionID)
    return {
      usage: tokens === undefined ? null : tokensOf(tokens),
      streaming: this.options.isStreaming(sessionID),
    }
  }

  async compact(sessionID: string, options: CompactOptions = {}): Promise<CompactionOutcome> {
    if (this.options.isStreaming(sessionID)) {
      throw new BackendError("conflict", `Session ${sessionID} already has an active run`)
    }
    const id = options.id ?? this.options.nextID()
    const cached = this.byId.get(id)
    if (cached) return cached

    const reason: CompactionReason = options.reason ?? "manual"
    this.options.emit(EVENT.compactionStarted, sessionID, { sessionID, reason }, true)
    const record = this.record(sessionID)
    record.count += 1
    record.lastReason = reason
    this.records.set(sessionID, record)

    const failures = this.failuresLeft.get(sessionID) ?? 0
    let outcome: CompactionOutcome
    if (failures > 0) {
      this.failuresLeft.set(sessionID, failures - 1)
      record.failures += 1
      this.options.emit(
        EVENT.compactionFailed,
        sessionID,
        {
          sessionID,
          reason,
          error: { type: "fake_error", message: FAKE_FAILURE },
        },
        true,
      )
      outcome = { status: "failed", id, error: FAKE_FAILURE }
    } else {
      this.options.emit(
        EVENT.compactionEnded,
        sessionID,
        { sessionID, reason, text: FAKE_SUMMARY },
        true,
      )
      outcome = { status: "ended", id, summary: FAKE_SUMMARY }
    }

    // A caller that did not ask to wait reads "accepted"; the events above are
    // still the record and reach the browser through the stream.
    const result: CompactionOutcome =
      (options.waitMs ?? 0) > 0 ? outcome : { status: "accepted", id }
    this.byId.set(id, outcome)
    return result
  }
}
