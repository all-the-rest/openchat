import type { Hono } from "hono"
import type { AppEnv } from "./app"
import type { RouteDeps } from "./routes"
import { SSE_RETRY_FRAME } from "./sse"
import { EVENT } from "@openchat/contracts"

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

/**
 * The one SSE proxy. It forwards the normalized event stream unchanged, adds a
 * retry frame and a heartbeat, and tears the backend subscription down with the
 * response so a closed browser tab cannot keep a host iterator open.
 */
export function registerEventRoute(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { backend, sseHeartbeatMs, fallback } = deps

  app.get("/api/events", (c) => {
    const lifecycle = new AbortController()
    const encoder = new TextEncoder()
    const subscription = backend.subscribe(lifecycle.signal)
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let finished = false

    const cleanup = () => {
      if (finished) return
      finished = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      lifecycle.abort()
    }

    const onAbort = () => cleanup()
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })
    if (c.req.raw.signal.aborted) cleanup()

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          controller.enqueue(encoder.encode(chunk))
        }
        const pump = async () => {
          try {
            write(`${SSE_RETRY_FRAME}\n\n`)
            heartbeat = setInterval(() => {
              try {
                write(": heartbeat\n\n")
              } catch {
                cleanup()
              }
            }, sseHeartbeatMs)
            for await (const event of subscription) {
              // The fallback engine observes text deltas and may turn a failed
              // attempt into a silent model switch. Never let an engine error
              // break the stream: fall back to forwarding the original event.
              // By default the original event is forwarded. On a taken retry
              // the failed event is replaced by the engine's synthetic events;
              // on success the outcome event is appended.
              let toWrite: Array<typeof event> = [event]
              if (fallback) {
                try {
                  fallback.observe(event)
                  if (event.type === EVENT.executionFailed) {
                    const result = await fallback.onFailure(event)
                    if (result.suppress) toWrite = result.events as Array<typeof event>
                  } else if (event.type === EVENT.executionSucceeded) {
                    const synthetic = await fallback.onSuccess(event)
                    toWrite = [...toWrite, ...synthetic as Array<typeof event>]
                  } else if (event.type === EVENT.interrupted) {
                    // A cancelled turn must not linger or be retried later.
                    const sessionID = event.data.sessionID
                    if (typeof sessionID === "string") fallback.forget(sessionID)
                  }
                } catch {
                  toWrite = [event]
                }
              }
              for (const out of toWrite) write(`data: ${JSON.stringify(out)}\n\n`)
            }
          } catch {
            // The client went away or the backend stopped; closing is enough.
          } finally {
            cleanup()
            c.req.raw.signal.removeEventListener("abort", onAbort)
            try {
              controller.close()
            } catch {
              // Already closed by the consumer.
            }
          }
        }
        void pump()
      },
      cancel() {
        cleanup()
      },
    })

    return new Response(body, { headers: sseHeaders() })
  })
}
