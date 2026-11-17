import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { FakeBackend, LiveBackend } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import { createApp } from "./app"
import { loadEnv } from "./env"
import { MAX_BODY_BYTES } from "./limits"

const config = loadEnv()

const backend: ChatBackend =
  config.BACKEND_MODE === "live"
    ? new LiveBackend({
        baseUrl: config.OPENCODE_URL,
        username: config.OPENCODE_USERNAME,
        password: config.OPENCODE_PASSWORD,
        workspace: config.WORKSPACE_DIR,
      })
    : new FakeBackend({
        scenario: config.FAKE_SCENARIO,
        workspace: config.WORKSPACE_DIR,
      })

const app = createApp({ config, backend })

function respondPayloadTooLarge(response: ServerResponse): void {
  if (response.headersSent) {
    response.end()
    return
  }
  response.statusCode = 413
  response.setHeader("content-type", "application/json")
  response.end(
    JSON.stringify({
      error: {
        code: "payload_too_large",
        message: `Request body must not exceed ${MAX_BODY_BYTES} bytes`,
      },
    }),
  )
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const lifecycle = new AbortController()
  response.on("close", () => lifecycle.abort())

  const declared = Number(request.headers["content-length"] ?? "")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume()
    respondPayloadTooLarge(response)
    return
  }

  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) {
      tooLarge = true
      break
    }
    chunks.push(buffer)
  }
  if (tooLarge) {
    // Discard the rest without buffering it; the response is already decided.
    request.resume()
    respondPayloadTooLarge(response)
    return
  }

  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }

  const method = request.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0
  const host = request.headers.host ?? `127.0.0.1:${config.PORT}`
  const url = new URL(request.url ?? "/", `http://${host}`)

  const webRequest = new Request(url, {
    method,
    headers,
    body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined,
    signal: lifecycle.signal,
  })

  const webResponse = await app.fetch(webRequest)

  response.statusCode = webResponse.status
  for (const [name, value] of webResponse.headers) {
    if (name.toLowerCase() === "set-cookie") continue
    response.setHeader(name, value)
  }
  const cookies = webResponse.headers.getSetCookie()
  if (cookies.length > 0) response.setHeader("set-cookie", cookies)

  if (!webResponse.body) {
    response.end()
    return
  }

  const reader = webResponse.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => response.once("drain", resolve))
      }
    }
  } finally {
    response.end()
  }
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.headersSent) {
      response.statusCode = 500
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: { code: "internal_error", message: "Unexpected server error" } }))
      return
    }
    response.end()
  })
})

server.listen(config.PORT, () => {
  console.log(
    `[openchat] server listening on http://localhost:${config.PORT} (mode=${config.BACKEND_MODE})`,
  )
})
