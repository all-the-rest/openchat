import type { ServerResponse } from "node:http"

/**
 * Response pump shared by the BFF's node adapter.
 *
 * Ported from `apps/code-host/src/node.ts`: the Code host streams the same way
 * (SSE on `/api/events`, asset and API bodies everywhere else), so a client
 * that stops reading and disconnects must not pin the handler, the web
 * `Response` or the upstream reader. The two copies are deliberately identical
 * in shape; each app ships its own node adapter.
 */

/** Hard ceiling for `reader.cancel()` during teardown. */
export const CANCEL_TIMEOUT_MS = 2_000

type DrainResult = "drain" | "closed"

/**
 * Waits for `drain`, but gives up when the peer goes away first. A client that
 * stops reading and disconnects never drains, so waiting only for `drain`
 * would leave the handler, the web `Response` and the upstream reader reachable
 * until the process exits.
 */
function waitForDrain(response: ServerResponse): Promise<DrainResult> {
  if (response.destroyed || response.writableEnded) return Promise.resolve("closed")
  return new Promise<DrainResult>((resolve) => {
    const settle = (result: DrainResult) => {
      response.off("drain", onDrain)
      response.off("close", onClose)
      response.off("error", onClose)
      resolve(result)
    }
    const onDrain = () => settle("drain")
    const onClose = () => settle("closed")
    response.once("drain", onDrain)
    response.once("close", onClose)
    response.once("error", onClose)
  })
}

/**
 * Cancels the reader, but never lets a hostile stream hold teardown: a reader
 * whose `cancel` never settles is abandoned at the deadline.
 */
async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([reader.cancel().catch(() => {}), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Pumps a web response body into the node response without buffering. A
 * teardown (client disconnect) cancels the reader instead of ending a dead
 * response, and the loop re-checks `destroyed` after every awaited wait.
 */
export async function pumpResponseBody(
  body: ReadableStream<Uint8Array>,
  response: ServerResponse,
  cancelTimeoutMs = CANCEL_TIMEOUT_MS,
): Promise<void> {
  const reader = body.getReader()
  let closed = response.destroyed
  try {
    while (!closed) {
      const { done, value } = await reader.read()
      if (done) break
      if (response.destroyed) {
        closed = true
        break
      }
      if (!response.write(Buffer.from(value))) {
        closed = (await waitForDrain(response)) === "closed"
      }
    }
  } finally {
    if (closed || response.destroyed) {
      await cancelReader(reader, cancelTimeoutMs)
    } else {
      response.end()
    }
  }
}
