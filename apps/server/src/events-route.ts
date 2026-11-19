import type { Hono } from "hono"
import type { EventEnvelope } from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { RouteDeps } from "./routes"
import { SSE_RETRY_FRAME } from "./sse"

/** The already-merged event stream a browser receives. */
export interface EventSource {
  /**
   * `onClose` fires when the producer ends this subscription itself — the
   * observer's bounded queue overflowing, a host drop, or an abort — so the
   * route can close a response whose pump is parked on backpressure.
   */
  subscribe(signal?: AbortSignal, onClose?: () => void): AsyncIterable<EventEnvelope>
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

/**
 * The one SSE proxy. It forwards the server-owned event stream unchanged, adds
 * a retry frame and a heartbeat, and tears its subscriber down with the
 * response. Fallback observation and retries live in `FallbackObserver`, so a
 * closed browser tab cannot stop a ledger row or a retry.
 */
export function registerEventRoute(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { events, sseHeartbeatMs } = deps

  app.get("/api/events", (c) => {
    const lifecycle = new AbortController()
    const encoder = new TextEncoder()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let finished = false
    let resumePump: (() => void) | undefined

    const cleanup = () => {
      if (finished) return
      finished = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      lifecycle.abort()
      // A pump blocked on a full queue must not stay parked after teardown.
      resumePump?.()
    }

    // The producer closed this subscription (queue bound, host drop or abort).
    // Ending the response here is what makes the EventSource reconnect; the
    // pump may be parked on backpressure and needs the wake-up. `cleanup` is
    // idempotent, so a second call after an abort is harmless.
    const subscription = events.subscribe(lifecycle.signal, () => {
      cleanup()
      resumePump?.()
    })

    const onAbort = () => cleanup()
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true })
    if (c.req.raw.signal.aborted) cleanup()

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const waitForCapacity = () => {
          if (controller.desiredSize !== null && controller.desiredSize > 0) {
            return Promise.resolve()
          }
          return new Promise<void>((resolve) => {
            resumePump = resolve
          })
        }
        const write = async (chunk: string) => {
          await waitForCapacity()
          if (finished) return
          controller.enqueue(encoder.encode(chunk))
        }
        const pump = async () => {
          try {
            await write(`${SSE_RETRY_FRAME}\n\n`)
            // A subscription that was already closed (upstream down, abort)
            // must not arm a heartbeat it can never clear.
            if (finished) return
            heartbeat = setInterval(() => {
              // A stalled consumer keeps its events queued in the observer,
              // where the bounded subscriber queue closes the stream and lets
              // EventSource reconnect. Heartbeats must not bypass that bound.
              if (finished) return
              if (controller.desiredSize === null || controller.desiredSize <= 0) return
              try {
                controller.enqueue(encoder.encode(": heartbeat\n\n"))
              } catch {
                cleanup()
              }
            }, sseHeartbeatMs)
            for await (const event of subscription) {
              await write(`data: ${JSON.stringify(event)}\n\n`)
            }
          } catch {
            // The client went away or the server stream stopped; closing is
            // enough, and a reconnect re-reads the transcript snapshot.
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
      pull() {
        const resume = resumePump
        resumePump = undefined
        resume?.()
      },
      cancel() {
        cleanup()
      },
    })

    return new Response(body, { headers: sseHeaders() })
  })
}
