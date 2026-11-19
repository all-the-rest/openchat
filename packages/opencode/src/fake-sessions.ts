import type { SessionInfo } from "@openchat/contracts"
import { BackendError } from "./errors"
import { clone } from "./fake-parts"
import type { SessionState } from "./fake-state"

/**
 * The fake host's session rows. Kept apart from the backend facade so the
 * session lifecycle (create, rename, delete) lives in one place and the
 * facade stays within the file-length budget.
 */
export class FakeSessionStore {
  private readonly byID = new Map<string, SessionState>()

  list(): SessionState[] {
    return [...this.byID.values()]
  }

  get(sessionID: string): SessionState | undefined {
    return this.byID.get(sessionID)
  }

  require(sessionID: string): SessionState {
    const session = this.byID.get(sessionID)
    if (!session) throw new BackendError("not_found", `Unknown session: ${sessionID}`)
    return session
  }

  seed(state: SessionState): void {
    this.byID.set(state.info.id, state)
  }
  create(info: SessionInfo, model?: string, agent?: string): SessionState {
    const state: SessionState = { info, messages: [], model, agent }
    this.byID.set(info.id, state)
    return state
  }

  /** Renames one chat and returns its new info; unknown ids throw `not_found`. */
  rename(sessionID: string, title: string, now: number): SessionInfo {
    const session = this.require(sessionID)
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      throw new BackendError("invalid", "A chat title must not be empty")
    }
    session.info.title = trimmed
    session.info.updated = now
    return clone(session.info)
  }

  /** Removes one chat; unknown ids throw `not_found` before anything changes. */
  remove(sessionID: string): SessionState {
    const session = this.require(sessionID)
    this.byID.delete(sessionID)
    return session
  }
}
