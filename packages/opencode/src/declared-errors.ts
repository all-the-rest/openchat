/**
 * The error shape the host client declares for a rejection.
 *
 * A response whose status is not declared by the endpoint becomes a
 * `ClientError` with `reason: "UnexpectedStatus"` and `cause.status`. A
 * declared status (e.g. a 400 or 404 in the endpoint's `declaredStatuses`) is
 * decoded into a tagged error object with a `_tag`, and therefore carries no
 * status field. Transport failures, timeouts and malformed bodies declare
 * neither, so a caller must treat "no declaration" as an unavailable host and
 * never invent a status for it.
 */

/** The status of an `UnexpectedStatus` rejection, when the client declares one. */
export function declaredStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined
  const failure = error as { reason?: unknown; cause?: { status?: unknown } }
  if (failure.reason !== "UnexpectedStatus") return undefined
  const status = failure.cause?.status
  return typeof status === "number" ? status : undefined
}

/** The `_tag` of a declared typed rejection, when the error carries one. */
export function declaredErrorTag(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined
  const tag = (error as { _tag?: unknown })._tag
  return typeof tag === "string" ? tag : undefined
}
