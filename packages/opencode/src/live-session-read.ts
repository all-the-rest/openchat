import type { OpenCodeClient } from "@opencode/client"
import { declaredErrorTag, declaredStatus } from "./declared-errors"
import { BackendError } from "./errors"

/**
 * A declared 404 is the host saying the resource is gone. Every other failure
 * (transport, 5xx, malformed body) is a read that did not happen and must not
 * turn into a 404 in the BFF. The host declares a missing session and a
 * missing form with distinct tags, so both count.
 */
export function isDeclaredMissing(error: unknown): boolean {
  const tag = declaredErrorTag(error)
  if (tag === "SessionNotFoundError" || tag === "FormNotFoundError") {
    return true
  }
  return declaredStatus(error) === 404
}

/** Kept for the session readers; the predicate is shared with the form reply. */
export const isMissingSession = isDeclaredMissing

/**
 * Pre-read before a write the host reports generically: an explicit missing
 * session stays `not_found`, a failed read becomes `unavailable` (502 in the
 * BFF) instead of claiming the chat does not exist.
 */
export async function requireSession(
  client: OpenCodeClient,
  sessionID: string,
): Promise<void> {
  let session: unknown
  try {
    session = await client.session.get({ sessionID })
  } catch (error) {
    if (isMissingSession(error)) {
      throw new BackendError("not_found", `Unknown session: ${sessionID}`)
    }
    throw new BackendError("unavailable", "The host did not read the chat")
  }
  if (session === null || session === undefined) {
    throw new BackendError("not_found", `Unknown session: ${sessionID}`)
  }
}
