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
import { classifyFailure, isFreeModel, nextModel, shouldFallback } from "./fallback-policy"
import { UsageLedgerError } from "./usage-ledger"

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
      isFree?: boolean
    }): Promise<void>
    paidTurnsToday(): Promise<number>
  }
  now?: () => number
  /** Boot/log sink; defaults to the server's `console.warn` prefix. */
  warn?: (message: string) => void
}

/** Opaque identity of one submission; only `begin` can mint one. */
export interface SubmissionToken {
  readonly id: symbol
}

function newSubmissionToken(): SubmissionToken {
  return { id: Symbol("openchat.submission") }
}

export interface TurnState {
  sessionID: string
  /** Identity of the submission that registered this state. */
  token: SubmissionToken
  policy: TurnPolicy
  payload: PromptInput
  /** Model the turn first asked for; kept for `turn.outcome.requested`. */
  initial: ModelRef
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
  private readonly warn: (message: string) => void
  private readonly turns = new Map<string, TurnState>()
  /** State `begin` replaced, restored when the submit is abandoned. */
  private readonly replaced = new Map<string, TurnState>()
  /** Sessions with a retry in flight; guards concurrent subscribers. */
  private readonly retrying = new Set<string>()
  /** A full ledger rejects every later row too; one warning per process. */
  private ledgerFullWarned = false

  constructor(deps: FallbackEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.warn = deps.warn ?? ((message) => console.warn(`[openchat] ${message}`))
  }

  /**
   * Registers a turn before the prompt is submitted, so output the host emits
   * while the POST is still open is already observed. `messageID` is unknown at
   * that point and is adopted from the response. The returned token identifies
   * this submission: a late `adopt`/`abandon` for an older overlapping begin
   * is a no-op instead of disturbing the newer registration.
   */
  begin(
    sessionID: string,
    payload: PromptInput,
    policy: TurnPolicy,
    requested: ModelRef,
    messageID?: string,
  ): SubmissionToken {
    // Map.set on an existing key keeps its position; only new sessions evict.
    if (!this.turns.has(sessionID) && this.turns.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.turns.keys().next().value
      if (oldest !== undefined) this.turns.delete(oldest)
    }
    // A prompt that turns out to be queued never starts a run; its registration
    // must not destroy the active turn it replaced.
    const previous = this.turns.get(sessionID)
    if (previous === undefined) this.replaced.delete(sessionID)
    else this.replaced.set(sessionID, previous)
    const token = newSubmissionToken()
    this.turns.set(sessionID, {
      sessionID,
      token,
      policy,
      payload,
      initial: requested,
      requested,
      attempts: 0,
      emittedText: "",
      tried: [],
      messageID,
    })
    return token
  }

  /** Attaches the host's message id once the prompt response arrives. */
  adopt(sessionID: string, token: SubmissionToken, messageID: string): void {
    const state = this.turns.get(sessionID)
    if (state === undefined || state.token !== token) return
    state.messageID = messageID
    this.replaced.delete(sessionID)
  }

  /**
   * Drops the just-registered turn because the host did not start a run
   * (queued or a submit error) and restores whatever turn it replaced. A
   * stale token cannot abandon the submission that replaced it.
   */
  abandon(sessionID: string, token: SubmissionToken): void {
    const state = this.turns.get(sessionID)
    if (state === undefined || state.token !== token) return
    const previous = this.replaced.get(sessionID)
    this.replaced.delete(sessionID)
    if (previous === undefined) this.turns.delete(sessionID)
    else this.turns.set(sessionID, previous)
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
    // A second report of the same failure must not forward the raw failure:
    // both tabs (or duplicate host events) then see the same retry outcome.
    // The guard is set before the first await, so the second call cannot pass
    // while the first one is still reading the ledger or submitting the retry.
    if (this.retrying.has(sessionID)) return { suppress: true, events: [] }
    this.retrying.add(sessionID)
    try {
      return await this.retryOnce(sessionID, state, failureFrom(event.data))
    } finally {
      this.retrying.delete(sessionID)
    }
  }

  private async retryOnce(
    sessionID: string,
    state: TurnState,
    failure: TurnFailure,
  ): Promise<FailureResult> {
    const attempts = state.attempts + 1
    // `tried` holds model keys; the core engine compares ModelRefs, so rebuild
    // the already-tried entries from the chain. The currently failing model is
    // tried too, otherwise the first failure would "fall back" to itself.
    const triedRefs = [
      ...state.policy.chain.filter((entry) => state.tried.includes(modelKey(entry))),
      state.requested,
    ]
    const next = nextModel(state.policy, triedRefs)
    const paidTurns = await this.deps.ledger.paidTurnsToday()
    const reason = classifyFailure(failure)

    const allowed = shouldFallback({
      policy: state.policy,
      failure,
      emittedText: state.emittedText,
      attempts,
      paidTurns,
      next,
      current: state.requested,
    })
    if (!allowed || next === undefined) {
      // No retry: the turn is over. Keeping its state would let a later
      // completion — for example a queued turn that starts next — be recorded
      // against this failed attempt.
      state.attempts = attempts
      this.turns.delete(sessionID)
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

    // The original prompt defaults to `queue`; a retry must start its own run
    // immediately instead of waiting behind a turn that has already failed.
    const retryPayload: PromptInput = { ...state.payload, modelRef: next }
    delete retryPayload.delivery

    let result: { messageID: string; queued?: boolean }
    try {
      result = await this.deps.backend.prompt(sessionID, retryPayload)
    } catch {
      // The retry could not be started; the turn is over and must not be
      // retried again from a later failure event.
      this.turns.delete(sessionID)
      return { suppress: false, events: [] }
    }
    if (result.queued === true) {
      this.turns.delete(sessionID)
      return { suppress: false, events: [] }
    }
    state.messageID = result.messageID

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
    const isFree = isFreeModel(answered) ? true : undefined
    try {
      await this.deps.ledger.record({
        providerID: answered.providerID,
        modelID: answered.modelID,
        turns: 1,
        costMicros: 0,
        ...(isFree === undefined ? {} : { isFree }),
      })
    } catch (error) {
      // A full ledger keeps refusing for the rest of the day, so the paid-turn
      // cap freezes at its last readable value. Say so once, with a fixed
      // message: the row and the ledger path never belong in a log.
      if (error instanceof UsageLedgerError && error.code === "usage_ledger_full") {
        if (!this.ledgerFullWarned) {
          this.ledgerFullWarned = true
          this.warn(
            "usage_ledger_full: paid-turn accounting stays frozen until the day rolls over",
          )
        }
      } else {
        throw error
      }
    }
    const outcome: TurnOutcomeData = {
      sessionID,
      requested: state.initial,
      answered,
      fellBack: state.tried.length > 0,
      // Completed attempts: the successful one plus every failed one before it.
      attempts: state.attempts + 1,
      ...(state.reason ? { reason: state.reason } : {}),
      costMicros: 0,
    }
    this.turns.delete(sessionID)
    return [this.envelope(EVENT.turnOutcome, outcome as unknown as Record<string, unknown>)]
  }

  forget(sessionID: string): void {
    this.turns.delete(sessionID)
    this.replaced.delete(sessionID)
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
