/**
 * Turn ownership for the fallback engine.
 *
 * One session has at most one current registration, but a newer submission can
 * shadow an older turn while its prompt POST is still open. Two id spaces are
 * kept apart: a prompt response id identifies the user's inbox entry, while
 * assistant output and terminal events carry the assistant message id. Output is
 * attributed to a turn by its known assistant id, otherwise to the oldest turn
 * still awaiting a terminal event; terminal events are matched by message id
 * first and fall back to the same FIFO.
 */
import type { FallbackReason, ModelRef, TurnPolicy } from "@openchat/contracts"
import type { PromptInput } from "@openchat/opencode"

/** More than this many simultaneous sessions, or message ids, are tracked. */
export const MAX_TRACKED_SESSIONS = 512
/** Bounds for overlapping submissions waiting for a terminal event. */
const MAX_AWAITING_PER_SESSION = 8
const MAX_AWAITING_TURNS = 512

/** Opaque identity of one submission; only `begin` can mint one. */
export interface SubmissionToken {
  readonly id: symbol
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
  reason?: FallbackReason
}

export interface ResolvedTurn {
  state: TurnState
  sessionID: string
  /** True when a newer registration has replaced this turn in `turns`. */
  superseded: boolean
}

function newSubmissionToken(): SubmissionToken {
  return { id: Symbol("openchat.submission") }
}

function sessionIDOf(data: Record<string, unknown>): string | undefined {
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}

export class TurnRegistry {
  private readonly turns = new Map<string, TurnState>()
  /** State `begin` replaced, restored when the submit is abandoned. */
  private readonly replaced = new Map<string, TurnState>()
  /** messageID → turn; populated by `adopt` and by a retry response. */
  private readonly byMessage = new Map<string, TurnState>()
  /** assistant messageID → turn that produced its output; filled by `observe`. */
  private readonly outputs = new Map<string, TurnState>()
  /** Per-session FIFO of turns whose terminal event has not arrived yet. */
  private readonly awaiting = new Map<string, TurnState[]>()
  private awaitingTotal = 0
  /** Message ids replaced by a retry; a late event for one is not re-attributed. */
  private readonly retired = new Set<string>()

  /**
   * Registers a turn before the prompt is submitted. `messageID` is normally
   * unknown at that point and adopted from the response. A prompt that turns out
   * to be queued never starts a run; its registration must not destroy the
   * active turn it replaced.
   */
  begin(
    sessionID: string,
    payload: PromptInput,
    policy: TurnPolicy,
    requested: ModelRef,
    messageID?: string,
  ): SubmissionToken {
    if (!this.turns.has(sessionID) && this.turns.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.turns.keys().next().value
      if (oldest !== undefined) this.forgetSession(oldest)
    }
    const previous = this.turns.get(sessionID)
    if (previous === undefined) this.replaced.delete(sessionID)
    else this.replaced.set(sessionID, previous)
    const token = newSubmissionToken()
    const state: TurnState = {
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
    }
    this.turns.set(sessionID, state)
    this.index(state)
    this.pushAwaiting(state)
    return token
  }

  /** Attaches the host's message id once the prompt response arrives. */
  adopt(sessionID: string, token: SubmissionToken, messageID: string): void {
    const state = this.turns.get(sessionID)
    if (state === undefined || state.token !== token) return
    state.messageID = messageID
    this.index(state)
    this.replaced.delete(sessionID)
  }

  /**
   * Drops the just-registered turn because the host did not start a run
   * (queued or a submit error) and restores whatever turn it replaced. A stale
   * token cannot abandon the submission that replaced it.
   */
  abandon(sessionID: string, token: SubmissionToken): void {
    const state = this.turns.get(sessionID)
    if (state === undefined || state.token !== token) return
    const previous = this.replaced.get(sessionID)
    if (state.messageID !== undefined && this.byMessage.get(state.messageID) === state) {
      this.byMessage.delete(state.messageID)
    }
    for (const messageID of this.outputIDsOf(state)) this.outputs.delete(messageID)
    this.removeAwaiting(state)
    this.replaced.delete(sessionID)
    if (previous === undefined) this.turns.delete(sessionID)
    else this.turns.set(sessionID, previous)
  }

  /** The session's current registration. */
  current(sessionID: string): TurnState | undefined {
    return this.turns.get(sessionID)
  }

  /**
   * The oldest turn of this session whose terminal event has not arrived yet.
   * The live host runs one turn per session, so this is the turn producing
   * output right now.
   */
  oldestAwaiting(sessionID: string): TurnState | undefined {
    return this.awaiting.get(sessionID)?.[0]
  }

  /**
   * The turn indexed by this message id. Retired retry ids have no owner: a
   * late event for the failed attempt must not be credited to the retried turn.
   */
  ownerOf(messageID: string): TurnState | undefined {
    if (this.retired.has(messageID)) return undefined
    return this.byMessage.get(messageID)
  }

  /**
   * The turn that already produced output for this assistant message id. A
   * retired id has no owner, exactly like `ownerOf`.
   */
  ownerOfOutput(messageID: string): TurnState | undefined {
    if (this.retired.has(messageID)) return undefined
    return this.outputs.get(messageID)
  }

  /**
   * Remembers an assistant message id as output of `state`. A dropped turn has
   * no ids to add, and an id already owned by another tracked turn is never
   * reassigned. Bounded like the terminal index.
   */
  trackOutput(state: TurnState, messageID: string): void {
    if (!this.isTracked(state)) return
    if (this.outputs.has(messageID)) return
    if (this.outputs.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.outputs.keys().next().value
      if (oldest !== undefined) this.outputs.delete(oldest)
    }
    this.outputs.set(messageID, state)
  }

  /** True when a retry replaced this id; its late events must be ignored. */
  isRetired(messageID: string): boolean {
    return this.retired.has(messageID)
  }

  /**
   * Resolves a terminal event to the turn that owns it. A known message id
   * always wins (the fake backend and a future host may carry it). The live host
   * omits it, so the oldest turn still awaiting a terminal event is the owner;
   * the host runs one turn per session and delivers events in order.
   */
  resolve(data: Record<string, unknown>): ResolvedTurn | undefined {
    const sessionID = sessionIDOf(data)
    const messageID = typeof data.messageID === "string" ? data.messageID : undefined
    if (messageID !== undefined) {
      const indexed = this.byMessage.get(messageID)
      if (indexed !== undefined) {
        return {
          state: indexed,
          sessionID: indexed.sessionID,
          superseded: this.turns.get(indexed.sessionID) !== indexed,
        }
      }
      // A retry retired this id. Its late event belongs to the failed attempt,
      // not to whichever turn the submission FIFO would pick next.
      if (this.retired.has(messageID)) return undefined
    }
    if (sessionID === undefined) return undefined
    const awaiting = this.awaiting.get(sessionID)?.[0]
    if (awaiting !== undefined) {
      return {
        state: awaiting,
        sessionID,
        superseded: this.turns.get(sessionID) !== awaiting,
      }
    }
    const state = this.turns.get(sessionID)
    if (state === undefined) return undefined
    // A different known id belongs to an untracked turn, not to this one.
    if (messageID !== undefined && state.messageID !== undefined && state.messageID !== messageID) {
      return undefined
    }
    return { state, sessionID, superseded: false }
  }

  /** Indexes a retry's message id; false when the turn was forgotten. */
  trackMessage(state: TurnState, messageID: string): boolean {
    if (!this.isTracked(state)) return false
    // A retry replaces the turn's message id. The old key must go, or a stale
    // terminal event for the failed attempt would resolve to this turn again.
    if (
      state.messageID !== undefined &&
      state.messageID !== messageID &&
      this.byMessage.get(state.messageID) === state
    ) {
      this.byMessage.delete(state.messageID)
      this.retire(state.messageID)
    }
    state.messageID = messageID
    this.index(state)
    return true
  }

  /** Removes one turn without disturbing a newer registration of its session. */
  drop(state: TurnState): void {
    if (state.messageID !== undefined && this.byMessage.get(state.messageID) === state) {
      this.byMessage.delete(state.messageID)
    }
    for (const messageID of this.outputIDsOf(state)) this.outputs.delete(messageID)
    this.removeAwaiting(state)
    if (this.turns.get(state.sessionID) === state) this.turns.delete(state.sessionID)
    if (this.replaced.get(state.sessionID) === state) this.replaced.delete(state.sessionID)
  }

  forget(sessionID: string): void {
    this.forgetSession(sessionID)
  }

  activeCount(): number {
    return this.turns.size
  }

  private forgetSession(sessionID: string): void {
    const current = this.turns.get(sessionID)
    if (current !== undefined) this.drop(current)
    const previous = this.replaced.get(sessionID)
    if (previous !== undefined) this.drop(previous)
    const queue = this.awaiting.get(sessionID)
    if (queue !== undefined) {
      this.awaitingTotal -= queue.length
      this.awaiting.delete(sessionID)
    }
    // A superseded turn may have already left `replaced` after the newer
    // submission was adopted but still sits in the message index.
    for (const [messageID, state] of this.byMessage) {
      if (state.sessionID === sessionID) this.byMessage.delete(messageID)
    }
    for (const [messageID, state] of this.outputs) {
      if (state.sessionID === sessionID) this.outputs.delete(messageID)
    }
  }

  /** Output ids credited to this turn. */
  private outputIDsOf(state: TurnState): string[] {
    const ids: string[] = []
    for (const [messageID, owner] of this.outputs) {
      if (owner === state) ids.push(messageID)
    }
    return ids
  }

  /** True while `drop`, `abandon` or a terminal outcome still knows the turn. */
  private isTracked(state: TurnState): boolean {
    if (this.turns.get(state.sessionID) === state) return true
    if (this.replaced.get(state.sessionID) === state) return true
    if (state.messageID !== undefined && this.byMessage.get(state.messageID) === state) return true
    return this.awaiting.get(state.sessionID)?.includes(state) ?? false
  }

  private pushAwaiting(state: TurnState): void {
    let queue = this.awaiting.get(state.sessionID)
    if (queue === undefined) {
      queue = []
      this.awaiting.set(state.sessionID, queue)
    }
    // Refuse the newest registration rather than evicting the FIFO head: the
    // head is the turn producing output right now, so dropping it would credit
    // that output to a later turn. The refused turn stays indexable by its own
    // message id and is still resolved as the session's current turn.
    if (queue.length >= MAX_AWAITING_PER_SESSION) return
    queue.push(state)
    this.awaitingTotal += 1
    // Overlapping sends across many sessions are pathological; cap the total
    // too, dropping the earliest queued entry rather than leaking it.
    while (this.awaitingTotal > MAX_AWAITING_TURNS) {
      const first = this.awaiting.keys().next().value
      if (first === undefined) break
      const oldest = this.awaiting.get(first)
      if (oldest === undefined) {
        this.awaiting.delete(first)
        continue
      }
      oldest.shift()
      this.awaitingTotal -= 1
      if (oldest.length === 0) this.awaiting.delete(first)
    }
  }

  private removeAwaiting(state: TurnState): void {
    const queue = this.awaiting.get(state.sessionID)
    if (queue === undefined) return
    const index = queue.indexOf(state)
    if (index === -1) return
    queue.splice(index, 1)
    this.awaitingTotal -= 1
    if (queue.length === 0) this.awaiting.delete(state.sessionID)
  }

  private index(state: TurnState): void {
    if (state.messageID === undefined) return
    // A reused id is live again; it must no longer look retired.
    this.retired.delete(state.messageID)
    if (!this.byMessage.has(state.messageID) && this.byMessage.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.byMessage.keys().next().value
      if (oldest !== undefined) this.byMessage.delete(oldest)
    }
    this.byMessage.set(state.messageID, state)
  }

  private retire(messageID: string): void {
    if (!this.retired.has(messageID) && this.retired.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.retired.values().next().value
      if (oldest !== undefined) this.retired.delete(oldest)
    }
    this.retired.add(messageID)
  }
}
