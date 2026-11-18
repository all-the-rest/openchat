import type { Hono } from "hono"
import type { AppEnv } from "./app"
import type { RouteDeps } from "./routes"
import { SSE_RETRY_FRAME } from "./sse"

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

export function registerEventRoute(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { backend, sseHeartbeatMs } = deps

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
              write(`data: ${JSON.stringify(event)}\n\n`)
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
