import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import type { Hono } from "hono"
import type { AppEnv } from "./app"
import { CSP_POLICIES } from "./proxy"

type CspResponse = Response & { readonly [CSP_POLICIES]?: string[] }

/**
 * Bridges the node request/response pair to the Hono app.
 *
 * Request bodies are streamed straight into the web `Request` (the proxy
 * forwards them), and response bodies are pumped chunk by chunk. Nothing is
 * buffered, so an SSE frame reaches the browser on the same tick it arrives.
 */
export function createNodeHandler(
  app: Hono<AppEnv>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    handleRequest(app, request, response).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ error: "internal_error" }))
        return
      }
      response.end()
    })
  }
}

export function createNodeServer(app: Hono<AppEnv>): Server {
  return createServer(createNodeHandler(app))
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  return headers
}

type DrainResult = "drain" | "closed"

/** Hard ceiling for `reader.cancel()` during teardown. */
export const CANCEL_TIMEOUT_MS = 2_000

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

async function handleRequest(
  app: Hono<AppEnv>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const lifecycle = new AbortController()
  response.on("close", () => lifecycle.abort())

  const method = request.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  const host = request.headers.host ?? "127.0.0.1"
  const url = new URL(request.url ?? "/", `http://${host}`)

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(request),
    signal: lifecycle.signal,
  }
  if (hasBody) {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>
    init.duplex = "half"
  }

  const webResponse = await app.fetch(new Request(url, init), {
    remoteAddress: request.socket.remoteAddress,
  })

  response.statusCode = webResponse.status
  const policies = (webResponse as CspResponse)[CSP_POLICIES]
  for (const [name, value] of webResponse.headers) {
    const lower = name.toLowerCase()
    if (lower === "set-cookie") continue
    if (lower === "content-security-policy" && policies) continue
    response.setHeader(name, value)
  }
  if (policies) response.setHeader("content-security-policy", policies)
  const cookies = webResponse.headers.getSetCookie()
  if (cookies.length > 0) response.setHeader("set-cookie", cookies)
  response.flushHeaders()

  if (!webResponse.body) {
    response.end()
    return
  }

  await pumpResponseBody(webResponse.body, response)
}
