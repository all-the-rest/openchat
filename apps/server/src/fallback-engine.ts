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
import type { SubmissionToken, TurnState } from "./fallback-registry"
import { TurnRegistry } from "./fallback-registry"
import { UsageLedgerError } from "./usage-ledger"

export type { SubmissionToken, TurnState } from "./fallback-registry"

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
  private readonly registry = new TurnRegistry()
  /** Sessions with a retry in flight; guards concurrent subscribers. */
  private readonly retrying = new Set<string>()
  /** A full ledger rejects every later row too; one warning per process. */
  private ledgerFullWarned = false
  /** Any other ledger failure; the settings page reports this once it is set. */
  private ledgerFailed = false
  private ledgerErrorWarned = false

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
    return this.registry.begin(sessionID, payload, policy, requested, messageID)
  }

  /** Attaches the host's message id once the prompt response arrives. */
  adopt(sessionID: string, token: SubmissionToken, messageID: string): void {
    this.registry.adopt(sessionID, token, messageID)
  }

  /**
   * Drops the just-registered turn because the host did not start a run
   * (queued or a submit error) and restores whatever turn it replaced. A
   * stale token cannot abandon the submission that replaced it.
   */
  abandon(sessionID: string, token: SubmissionToken): void {
    this.registry.abandon(sessionID, token)
  }

  /**
   * Accumulates any assistant-visible output for the turn that produced it. A
   * retry is only safe before text, reasoning OR tool output has been emitted; a
   * turn that already showed work must keep its own failure rather than be
   * silently re-run.
   *
   * The prompt response id is the *user* inbox id, so it can never match an
   * output event: those carry the assistant message id. Output is therefore
   * credited by its known assistant id, else to the session's oldest turn still
   * awaiting a terminal event — the host runs one turn per session and delivers
   * events in order, so that turn is the one producing output now.
   */
  observe(event: EngineEvent): void {
    if (event.type !== EVENT.textDelta && event.type !== EVENT.reasoningDelta && event.type !== EVENT.toolUpdated) return
    const sessionID = sessionIDOf(event.data)
    if (sessionID === undefined) return
    const messageID =
      typeof event.data.messageID === "string" ? event.data.messageID : undefined
    // A retired id belongs to a failed attempt that was already replaced.
    if (messageID !== undefined && this.registry.isRetired(messageID)) return
    const state =
      (messageID === undefined ? undefined : this.registry.ownerOfOutput(messageID)) ??
      // A known terminal/adopted id belongs to its own turn, never to the FIFO
      // head of a different one.
      (messageID === undefined ? undefined : this.registry.ownerOf(messageID)) ??
      this.registry.oldestAwaiting(sessionID) ??
      this.registry.current(sessionID)
    if (state === undefined) return
    // Remember which assistant id produces this turn's output, so later deltas
    // of the same message stay credited to it.
    if (messageID !== undefined) this.registry.trackOutput(state, messageID)
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
    const resolved = this.registry.resolve(event.data)
    if (resolved === undefined) return { suppress: false, events: [] }
    const { state, sessionID, superseded } = resolved
    // The turn was replaced while this failure was in flight. Retrying would
    // re-prompt the newer submission's payload under the old turn's failure, so
    // forward the failure and drop only the stale state.
    if (superseded) {
      this.registry.drop(state)
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
      this.registry.drop(state)
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
      this.registry.drop(state)
      return { suppress: false, events: [] }
    }
    if (result.queued === true) {
      this.registry.drop(state)
      return { suppress: false, events: [] }
    }
    // The retry's message id owns its terminal event, including when a newer
    // submission shadowed this turn while the POST was open.
    if (!this.registry.trackMessage(state, result.messageID)) {
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
    const resolved = this.registry.resolve(event.data)
    if (resolved === undefined) return []
    const { state, sessionID } = resolved

    const answered = state.requested
    const isFree = isFreeModel(answered) ? true : undefined
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
    // Drop before the ledger write, not after: while the write is in flight the
    // turn is over, so a delta of the next (already registered) turn must not
    // resolve to this state's FIFO slot and then be wiped by its drop. Dropping
    // a superseded turn must not delete the newer registration either: the
    // outcome belongs to the old turn and the new one keeps its own state.
    this.registry.drop(state)
    try {
      await this.deps.ledger.record({
        providerID: answered.providerID,
        modelID: answered.modelID,
        turns: 1,
        costMicros: 0,
        ...(isFree === undefined ? {} : { isFree }),
      })
    } catch (error) {
      this.noteLedgerFailure(error)
    }
    return [this.envelope(EVENT.turnOutcome, outcome as unknown as Record<string, unknown>)]
  }

  /** True once any ledger write failed; the failure is sticky for this process. */
  ledgerError(): boolean {
    return this.ledgerFailed
  }

  forget(sessionID: string): void {
    this.registry.forget(sessionID)
  }

  activeCount(): number {
    return this.registry.activeCount()
  }

  /**
   * A ledger failure must never swallow a turn's outcome. A full ledger keeps
   * refusing for the rest of the day, so the paid-turn cap freezes at its last
   * readable value. Both cases set the sticky flag; each warning is fixed text
   * because the row and the ledger path never belong in a log.
   */
  private noteLedgerFailure(error: unknown): void {
    this.ledgerFailed = true
    if (error instanceof UsageLedgerError && error.code === "usage_ledger_full") {
      if (this.ledgerFullWarned) return
      this.ledgerFullWarned = true
      this.warn("usage_ledger_full: paid-turn accounting stays frozen until the day rolls over")
      return
    }
    if (this.ledgerErrorWarned) return
    this.ledgerErrorWarned = true
    this.warn("usage_ledger_write_failed: turn accounting could not be recorded")
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
