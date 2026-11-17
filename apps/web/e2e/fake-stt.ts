/**
 * Minimal Whisper-compatible service for the E2E suite. It answers the two
 * routes the BFF uses — `GET /healthz` for readiness and
 * `POST /audio/transcriptions` for the transcript — and discards every request
 * body without logging it. Audio never leaves this process and is not stored.
 */
import { createServer } from "node:http"

const HOST = "127.0.0.1"
const PORT = 8899
/** Returned for every upload; the E2E spec asserts this exact text. */
const FAKE_TRANSCRIPT = "Diktat aus dem Browser."

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname

  if (request.method === "GET" && path === "/healthz") {
    request.resume()
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
    return
  }

  if (request.method === "POST" && path === "/audio/transcriptions") {
    // Consume and drop the multipart body; respond only once it ended so the
    // upstream fetch never sees a reset connection.
    request.on("data", () => undefined)
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ text: FAKE_TRANSCRIPT }))
    })
    request.on("error", () => {
      if (!response.headersSent) response.writeHead(400)
      response.end()
    })
    return
  }

  request.resume()
  response.writeHead(404, { "content-type": "application/json" })
  response.end(JSON.stringify({ error: "not_found" }))
})

server.listen(PORT, HOST)

function shutdown(): void {
  server.close(() => process.exit(0))
  // Keep-alive sockets from the BFF must not delay the exit.
  server.closeAllConnections()
  setTimeout(() => process.exit(0), 2_000).unref()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
