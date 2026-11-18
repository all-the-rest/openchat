import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { CHAT_FILE_BODY_CEILING_BYTES } from "@openchat/contracts"
import { FakeBackend, FakeHostSwitch, LiveBackend } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import { createApp } from "./app"
import { INTERNAL_ARTIFACTS_PATH } from "./artifacts-internal"
import { reportChatFileOrphans } from "./chat-files-audit"
import { isChatFilesUploadPath } from "./chat-files-paths"
import { loadEnv } from "./env"
import { ARTIFACT_BODY_MAX_BYTES, MAX_BODY_BYTES } from "./limits"
import { pumpResponseBody } from "./pump"
import { serveStatic } from "./static"
import { TRANSCRIBE_PATH } from "./transcribe"

const config = loadEnv()
/**
 * Built SPA directory. Empty in development, where Vite serves the shell; set
 * to `/app/web` in the image. Static files are answered before the API app so
 * a request never pays for the Hono dispatch or the JSON body reader.
 */
const staticDir = config.WEB_DIST_DIR

const backend: ChatBackend =
  config.BACKEND_MODE === "live"
    ? new LiveBackend({
        baseUrl: config.OPENCODE_URL,
        username: config.OPENCODE_USERNAME,
        password: config.OPENCODE_PASSWORD,
        workspace: config.WORKSPACE_DIR,
      })
    : new FakeHostSwitch(
        new FakeBackend({
          scenario: config.FAKE_SCENARIO,
          workspace: config.WORKSPACE_DIR,
          appsAvailable: config.FAKE_APPS,
        }),
      )

const app = createApp({ config, backend })

function respondPayloadTooLarge(response: ServerResponse, maxBytes = MAX_BODY_BYTES): void {
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
        message: `Request body must not exceed ${maxBytes} bytes`,
      },
    }),
  )
}

/**
 * Writes a `Response` onto the node response: headers first, then the body
 * streamed rather than buffered. Shared by the static path and the API app so
 * both keep the same set-cookie and pumping behaviour.
 */
async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
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

  await pumpResponseBody(webResponse.body, response)
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const lifecycle = new AbortController()
  response.on("close", () => lifecycle.abort())

  const method = request.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  const host = request.headers.host ?? `127.0.0.1:${config.PORT}`
  const url = new URL(request.url ?? "/", `http://${host}`)

  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }

  if (staticDir) {
    const staticResponse = await serveStatic(
      { distDir: staticDir },
      new Request(url, { method, headers }),
    )
    if (staticResponse) {
      await writeWebResponse(response, staticResponse)
      return
    }
  }

  let webRequest: Request

  if (url.pathname === TRANSCRIBE_PATH) {
    // Audio is streamed straight into Hono: the route reads incrementally and
    // aborts at DICTATION_MAX_BYTES, so a large upload is never buffered here.
    const init: RequestInit & { duplex: "half" } = {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(request) as ReadableStream<Uint8Array>) : undefined,
      signal: lifecycle.signal,
      duplex: "half",
    }
    webRequest = new Request(url, init)
  } else {
    // The internal artifact route carries a compiled document, so its envelope
    // matches the public artifact route instead of the generic JSON cap.
    const bodyCap = isChatFilesUploadPath(url.pathname)
      ? CHAT_FILE_BODY_CEILING_BYTES
      : url.pathname === INTERNAL_ARTIFACTS_PATH
        ? ARTIFACT_BODY_MAX_BYTES
        : MAX_BODY_BYTES
    const declared = Number(request.headers["content-length"] ?? "")
    if (Number.isFinite(declared) && declared > bodyCap) {
      request.resume()
      respondPayloadTooLarge(response, bodyCap)
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > bodyCap) {
        tooLarge = true
        break
      }
      chunks.push(buffer)
    }
    if (tooLarge) {
      // Discard the rest without buffering it; the response is already decided.
      request.resume()
      respondPayloadTooLarge(response, bodyCap)
      return
    }

    webRequest = new Request(url, {
      method,
      headers,
      body: hasBody && chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined,
      signal: lifecycle.signal,
    })
  }

  const webResponse = await app.fetch(webRequest, {
    remoteAddress: request.socket.remoteAddress,
  })

  await writeWebResponse(response, webResponse)
}

// Read-only boot audit: names chat directories without a session and files
// without metadata. It never deletes, and a host that cannot list sessions
// (offline at boot) must not block the listen.
void backend
  .listSessions()
  .then((sessions) =>
    reportChatFileOrphans({
      workspaceDir: config.WORKSPACE_DIR,
      sessionIDs: sessions.map((session) => session.id),
    }),
  )
  .catch(() => undefined)

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

server.listen(config.PORT, config.HOST, () => {
  console.log(
    `[openchat] server listening on http://${config.HOST}:${config.PORT} (mode=${config.BACKEND_MODE})`,
  )
})
