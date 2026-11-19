/**
 * Per-turn fallback state machine. It sits between the normalized event stream
 * and the client: it watches one session's text, and on a failed attempt it
 * decides whether a single retry on the next chain model is allowed. When it is,
 * the original failure is dropped and two synthetic events are emitted instead:
 * a notice about the switch and the turn's eventual outcome.
 *
 * Pure with respect to Hono: the BFF injects the prompt port, the ledger and an
 * optional clock. One active run per session is tracked, bounded to avoid a
 * leak in a long-lived server.
 */
import { randomUUID } from "node:crypto"

import type {
  EventEnvelope,
  FallbackNoticeData,
  ModelRef,
  TurnOutcomeData,
  TurnPolicy,
} from "@openchat/contracts"
import { EVENT, modelKey } from "@openchat/contracts"
import type { PromptInput } from "@openchat/opencode"

import type { TurnFailure } from "./fallback-policy"
import { classifyFailure, nextModel, shouldFallback } from "./fallback-policy"

/** More than this many simultaneous sessions are never tracked. */
const MAX_TRACKED_SESSIONS = 512

export interface FallbackEngineDeps {
  backend: {
    prompt(
      sessionID: string,
      input: PromptInput,
    ): Promise<{ messageID: string; queued?: boolean }>
  }
  ledger: {
    record(entry: {
      providerID: string
      modelID: string
      turns: number
      costMicros: number
    }): Promise<void>
    spentToday(): Promise<number>
  }
  now?: () => number
}

export interface TurnState {
  sessionID: string
  policy: TurnPolicy
  payload: PromptInput
  requested: ModelRef
  attempts: number
  emittedText: string
  /** modelKey of every model that has already failed this turn. */
  tried: string[]
  messageID?: string
  /** Reason of the first failure that triggered a fallback, for the outcome. */
  reason?: import("@openchat/contracts").FallbackReason
}

export interface EngineEvent {
  type: string
  data: Record<string, unknown>
}

export interface FailureResult {
  suppress: boolean
  events: EngineEvent[]
}

function sessionIDOf(data: Record<string, unknown>): string | undefined {
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}

function failureFrom(data: Record<string, unknown>): TurnFailure {
  return {
    code: typeof data.code === "string" ? data.code : undefined,
    message: typeof data.message === "string" ? data.message : undefined,
    retryable: typeof data.retryable === "boolean" ? data.retryable : undefined,
  }
}

export class FallbackEngine {
  private readonly deps: FallbackEngineDeps
  private readonly now: () => number
  private readonly turns = new Map<string, TurnState>()

  constructor(deps: FallbackEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /** Registers a turn, replacing any prior state for the same session. */
  begin(
    sessionID: string,
    payload: PromptInput,
    policy: TurnPolicy,
    requested: ModelRef,
    messageID?: string,
  ): void {
    // Map.set on an existing key keeps its position; only new sessions evict.
    if (!this.turns.has(sessionID) && this.turns.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.turns.keys().next().value
      if (oldest !== undefined) this.turns.delete(oldest)
    }
    this.turns.set(sessionID, {
      sessionID,
      policy,
      payload,
      requested,
      attempts: 0,
      emittedText: "",
      tried: [],
      messageID,
    })
  }

  /**
   * Accumulates any assistant-visible output for a tracked session. A retry is
   * only safe before text, reasoning OR tool output has been emitted; a turn
   * that already showed work must keep its own failure rather than be silently
   * re-run.
   */
  observe(event: EngineEvent): void {
    if (event.type !== EVENT.textDelta && event.type !== EVENT.reasoningDelta && event.type !== EVENT.toolUpdated) return
    const sessionID = sessionIDOf(event.data)
    if (sessionID === undefined) return
    const state = this.turns.get(sessionID)
    if (state === undefined) return
    if (typeof event.data.delta === "string") {
      state.emittedText += event.data.delta
    } else {
      // Tool updates carry no text delta but are visible work: any non-empty
      // marker blocks the retry just like whitespace text does.
      state.emittedText += " "
    }
  }

  /**
   * Handles a failed attempt. Returns `suppress: true` with the events to emit
   * in place of the original failure when a retry was taken, otherwise the
   * caller forwards the original failure unchanged.
   */
  async onFailure(event: EngineEvent): Promise<FailureResult> {
    if (event.type !== EVENT.executionFailed) return { suppress: false, events: [] }
    const sessionID = sessionIDOf(event.data)
    const state = sessionID === undefined ? undefined : this.turns.get(sessionID)
    if (state === undefined || sessionID === undefined) {
      return { suppress: false, events: [] }
    }

    const failure = failureFrom(event.data)
    const attempts = state.attempts + 1
    // `tried` holds model keys; the core engine compares ModelRefs, so rebuild
    // the already-tried entries from the chain. The currently failing model is
    // tried too, otherwise the first failure would "fall back" to itself.
    const triedRefs = [
      ...state.policy.chain.filter((entry) => state.tried.includes(modelKey(entry))),
      state.requested,
    ]
    const next = nextModel(state.policy, triedRefs)
    const paidSpent = await this.deps.ledger.spentToday()
    const reason = classifyFailure(failure)

    const allowed = shouldFallback({
      policy: state.policy,
      failure,
      emittedText: state.emittedText,
      attempts,
      paidSpent,
      next,
    })
    if (!allowed || next === undefined) {
      state.attempts = attempts
      return { suppress: false, events: [] }
    }

    // The model that just failed is both the "from" of the notice and the
    // requested model of the outcome: only one retry per turn is ever allowed.
    const from = state.requested
    state.tried.push(modelKey(state.requested))
    state.attempts = attempts
    state.requested = next
    state.emittedText = ""
    state.reason = reason

    try {
      const result = await this.deps.backend.prompt(sessionID, { ...state.payload, modelRef: next })
      state.messageID = result.messageID
    } catch {
      // The retry could not be started; keep the original error visible.
      return { suppress: false, events: [] }
    }

    // Only the notice is emitted here. The outcome belongs to the completed
    // turn and is emitted by onSuccess — claiming `answered` before the retry
    // has actually answered would be factually wrong (and produced a duplicate
    // outcome when the retry succeeded).
    const notice: FallbackNoticeData = {
      sessionID,
      messageID: state.messageID,
      from,
      to: next,
      reason,
      attempts,
    }
    return {
      suppress: true,
      events: [this.envelope(EVENT.fallbackNotice, notice as unknown as Record<string, unknown>)],
    }
  }

  /** Records the answered model and closes a successful turn. */
  async onSuccess(event: EngineEvent): Promise<EngineEvent[]> {
    if (event.type !== EVENT.executionSucceeded) return []
    const sessionID = sessionIDOf(event.data)
    const state = sessionID === undefined ? undefined : this.turns.get(sessionID)
    if (state === undefined || sessionID === undefined) return []

    const answered = state.requested
    await this.deps.ledger.record({
      providerID: answered.providerID,
      modelID: answered.modelID,
      turns: 1,
      costMicros: 0,
    })
    const outcome: TurnOutcomeData = {
      sessionID,
      requested: nextModel(state.policy, []) ?? answered,
      answered,
      fellBack: state.tried.length > 0,
      attempts: state.attempts,
      ...(state.reason ? { reason: state.reason } : {}),
      costMicros: 0,
    }
    this.turns.delete(sessionID)
    return [this.envelope(EVENT.turnOutcome, outcome as unknown as Record<string, unknown>)]
  }

  forget(sessionID: string): void {
    this.turns.delete(sessionID)
  }

  activeCount(): number {
    return this.turns.size
  }

  /** Builds an `EventEnvelope`-shaped synthetic event with a fresh id. */
  private envelope(type: string, data: Record<string, unknown>): EventEnvelope {
    return {
      id: `fb_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      created: this.now(),
      type,
      data,
    }
  }
}
