import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { DictationInfo, TranscriptionResponse } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"

const AUDIO = "Audio-Bytes-0123456789"
const MAX_CAP = 1024

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingMessage["headers"]
  body: Buffer
}

interface FakeStt {
  url: string
  requests: CapturedRequest[]
  close(): Promise<void>
}

type SttHandler = (request: CapturedRequest, response: ServerResponse) => void

const openServers: FakeStt[] = []
const createdDirs: string[] = []

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(payload))
}

/** A real HTTP server on a random port, so fetch and multipart are exercised. */
async function startStt(handler?: SttHandler): Promise<FakeStt> {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => {
      const captured: CapturedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      }
      requests.push(captured)
      if (handler) handler(captured, response)
      else respondJson(response, 200, { text: "hello from whisper" })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("No STT port")
  const fake: FakeStt = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  openServers.push(fake)
  return fake
}

function firstRequest(stt: FakeStt): CapturedRequest {
  const captured = stt.requests[0]
  if (!captured) throw new Error("The fake STT service received no request")
  return captured
}

/** Minimal multipart reader: field name to raw value, enough for assertions. */
function multipartFields(captured: CapturedRequest): Map<string, string> {
  const contentType = String(captured.headers["content-type"] ?? "")
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  const marker = boundary?.[1] ?? boundary?.[2]?.trim()
  if (!marker) throw new Error(`No multipart boundary in ${contentType}`)
  const text = captured.body.toString("latin1")
  const fields = new Map<string, string>()
  for (const part of text.split(`--${marker}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1]
    if (!name) continue
    const bodyStart = part.indexOf("\r\n\r\n")
    if (bodyStart < 0) continue
    fields.set(name, part.slice(bodyStart + 4, part.lastIndexOf("\r\n")))
  }
  return fields
}

function transcribeServer(stt: FakeStt, env: Record<string, string | undefined> = {}, timeoutMs = 500) {
  return makeServer({
    env: { STT_URL: stt.url, DICTATION_MAX_BYTES: String(MAX_CAP), ...env },
    sttTimeoutMs: timeoutMs,
  })
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()))
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("POST /api/transcribe", () => {
  it("forwards audio as multipart and returns text with a duration", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt, { STT_API_KEY: "stt-secret-key" })
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe?language=en-US", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm;codecs=opus" },
      body: AUDIO,
    })

    expect(response.status).toBe(200)
    const result = await json<TranscriptionResponse>(response)
    expect(result.text).toBe("hello from whisper")
    expect(typeof result.durationMs).toBe("number")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    const captured = firstRequest(stt)
    expect(captured.method).toBe("POST")
    expect(captured.url).toBe("/audio/transcriptions")
    expect(captured.headers.authorization).toBe("Bearer stt-secret-key")
    expect(captured.headers.cookie).toBeUndefined()

    const fields = multipartFields(captured)
    expect(fields.get("model")).toBe("whisper-1")
    expect(fields.get("language")).toBe("en-US")
    expect(fields.get("file")).toBe(AUDIO)
    expect(captured.body.toString("latin1")).toContain('filename="audio.webm"')
  })

  it("ignores an implausible language tag and sends no bearer without a key", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe?language=en_US!", {
      method: "POST",
      headers: { cookie, "content-type": "audio/wav" },
      body: AUDIO,
    })

    expect(response.status).toBe(200)
    const captured = firstRequest(stt)
    expect(captured.headers.authorization).toBeUndefined()
    expect(multipartFields(captured).has("language")).toBe(false)
  })

  it("requires authentication", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: AUDIO,
    })

    expect(response.status).toBe(401)
    expect(await json(response)).toMatchObject({ error: { code: "unauthorized" } })
    expect(stt.requests).toHaveLength(0)
  })

  it("rejects a missing or non-audio content type", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const missing = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(missing.status).toBe(415)
    expect(await json(missing)).toMatchObject({
      error: { code: "unsupported_media_type" },
    })

    const wrong = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: AUDIO,
    })
    expect(wrong.status).toBe(415)
    expect(stt.requests).toHaveLength(0)
  })

  it("rejects an empty audio body", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: new Uint8Array(0),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "invalid_request" } })
    expect(stt.requests).toHaveLength(0)
  })

  it("keeps the cross-origin guard on the audio route", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "audio/webm",
        origin: "http://evil.example",
        host: "localhost:8787",
      },
      body: AUDIO,
    })

    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({ error: { code: "cross_origin" } })
    expect(stt.requests).toHaveLength(0)
  })

  it("rejects a streamed body above the cap and accepts one exactly at it", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const tooLarge = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: new Uint8Array(MAX_CAP + 1),
    })
    expect(tooLarge.status).toBe(413)
    expect(await json(tooLarge)).toMatchObject({
      error: { code: "payload_too_large" },
    })
    expect(stt.requests).toHaveLength(0)

    const atCap = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: new Uint8Array(MAX_CAP),
    })
    expect(atCap.status).toBe(200)
    expect(stt.requests).toHaveLength(1)
  })

  it("rejects a declared content-length above the cap without reading", async () => {
    const stt = await startStt()
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "audio/webm",
        "content-length": String(MAX_CAP + 1),
      },
      body: new Uint8Array(8),
    })

    expect(response.status).toBe(413)
    expect(stt.requests).toHaveLength(0)
  })

  it("answers 503 when no STT service is configured", async () => {
    const server = makeServer({ env: { STT_URL: undefined } })
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: AUDIO,
    })

    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({ error: { code: "stt_unavailable" } })
  })

  it("maps an upstream timeout to 504", async () => {
    const stt = await startStt(() => {
      // Never answers; the route's AbortController is the only deadline.
    })
    const server = transcribeServer(stt, {}, 50)
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: AUDIO,
    })

    expect(response.status).toBe(504)
    expect(await json(response)).toMatchObject({ error: { code: "stt_timeout" } })
  })

  it("maps an upstream 500 to 502", async () => {
    const stt = await startStt((_request, response) =>
      respondJson(response, 500, { error: "boom" }),
    )
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: AUDIO,
    })

    expect(response.status).toBe(502)
    expect(await json(response)).toMatchObject({ error: { code: "stt_failed" } })
  })

  it("answers 422 for an empty transcript", async () => {
    const stt = await startStt((_request, response) =>
      respondJson(response, 200, { text: "   " }),
    )
    const server = transcribeServer(stt)
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: AUDIO,
    })

    expect(response.status).toBe(422)
    expect(await json(response)).toMatchObject({ error: { code: "empty_transcript" } })
  })

  it("does not write the audio into WORKSPACE_DIR", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openchat-stt-"))
    createdDirs.push(workspace)
    const stt = await startStt()
    const server = transcribeServer(stt, { WORKSPACE_DIR: workspace })
    const cookie = await login(server)

    const response = await server.app.request("/api/transcribe", {
      method: "POST",
      headers: { cookie, "content-type": "audio/webm" },
      body: AUDIO,
    })

    expect(response.status).toBe(200)
    expect(readdirSync(workspace)).toEqual([])
  })

  it("reports dictation limits and availability through /api/info", async () => {
    const stt = await startStt()
    const enabled = transcribeServer(stt, {
      DICTATION_MAX_SECONDS: "90",
      DICTATION_MAX_BYTES: "2048",
    })
    const cookie = await login(enabled)
    const info = await json<{ dictation: DictationInfo }>(
      await enabled.app.request("/api/info", { headers: { cookie } }),
    )
    expect(info.dictation).toEqual({
      enabled: true,
      maxSeconds: 90,
      maxBytes: 2048,
      local: { available: false, model: "whisper-base" },
      server: { available: true },
    })

    const disabled = makeServer({ env: { STT_URL: undefined } })
    const disabledCookie = await login(disabled)
    const infoResponse = await disabled.app.request("/api/info", {
      headers: { cookie: disabledCookie },
    })
    const disabledInfo = await json<{ dictation: DictationInfo }>(infoResponse)
    expect(disabledInfo.dictation).toEqual({
      enabled: false,
      maxSeconds: 120,
      maxBytes: 26_214_400,
      local: { available: false, model: "whisper-base" },
      server: { available: false },
    })
  })
})
