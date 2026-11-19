import type { Message, SessionInfo } from "@openchat/contracts"
import { clone } from "./fake-parts"
import type { SessionState } from "./fake-state"

/** State a fork needs from the backend that owns the clock and ids. */
export interface ForkContext {
  id: string
  now: number
}

/**
 * Copies a session's history before one message into a new branch. The parent
 * state is never mutated, so the old branch stays reachable. Message ids are
 * kept, matching `session.fork({ before })` on the host: the boundary id stays
 * resolvable in the parent, which is what the branch counter reads.
 */
export function forkSessionState(
  parent: SessionState,
  beforeMessageID: string,
  context: ForkContext,
): SessionState | null {
  const boundary = parent.messages.findIndex((message) => message.id === beforeMessageID)
  if (boundary === -1) return null

  const info: SessionInfo = {
    id: context.id,
    // The title is inherited, never rewritten by a fork.
    title: parent.info.title,
    directory: parent.info.directory,
    created: context.now,
    updated: context.now,
    branchOf: parent.info.id,
    branchBefore: beforeMessageID,
  }
  const messages: Message[] = parent.messages.slice(0, boundary).map((message) => ({
    ...clone(message),
    sessionID: info.id,
  }))
  return {
    info,
    messages,
    // The host carries instruction entries into a fork, so a host-side index
    // or preference set is not lost on the new branch.
    instructions: parent.instructions ? new Map(parent.instructions) : undefined,
  }
}
