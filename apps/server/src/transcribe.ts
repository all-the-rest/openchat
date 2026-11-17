import type { Context, Hono } from "hono"
import type { TranscriptionResponse } from "@openchat/contracts"
import type { AppEnv } from "./app"
import type { RouteDeps } from "./routes"
import { jsonError } from "./http"

export const TRANSCRIBE_PATH = "/api/transcribe"

/** Upstream Whisper-compatible endpoint, appended to `STT_URL`. */
const UPSTREAM_PATH = "/audio/transcriptions"
const MODEL = "whisper-1"
export const STT_TIMEOUT_MS = 30_000
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
const LANGUAGE_MAX_LENGTH = 16

/** Returned when the streamed audio crosses the configured byte cap. */
const AUDIO_TOO_LARGE = Symbol("audio-too-large")

/** Backed by a plain ArrayBuffer, so it is a valid BlobPart. */
type AudioBytes = Uint8Array<ArrayBuffer>

type AudioResult = AudioBytes | typeof AUDIO_TOO_LARGE

function audioType(c: Context<AppEnv>): string | undefined {
  const header = c.req.header("content-type")
  if (!header) return undefined
  const type = header.split(";")[0]?.trim().toLowerCase() ?? ""
  if (!type.startsWith("audio/") || type === "audio/") return undefined
  return type
}

/**
 * Derives an upload filename from the audio content type. Whisper clients use
 * the extension as a hint, so `audio/webm` becomes `audio.webm`.
 */
function filenameFor(type: string): string {
  const subtype = type.slice("audio/".length).replace(/[^a-z0-9.+-]/g, "")
  return `audio.${subtype || "bin"}`
}

/** A plausible BCP-47-ish tag; anything else is ignored rather than rejected. */
function languageHint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const candidate = value.trim()
  if (candidate.length === 0 || candidate.length > LANGUAGE_MAX_LENGTH) return undefined
  return LANGUAGE_PATTERN.test(candidate) ? candidate : undefined
}

function upstreamUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${UPSTREAM_PATH}`
}

function concat(chunks: Uint8Array[], size: number): AudioBytes {
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Reads the raw body incrementally and stops at the cap, so an oversized
 * upload never sits fully in memory. The caller answers 413 as soon as this
 * returns `AUDIO_TOO_LARGE`; nothing is written to disk.
 */
async function readAudio(c: Context<AppEnv>, maxBytes: number): Promise<AudioResult> {
  const body = c.req.raw.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return AUDIO_TOO_LARGE
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream was already cancelled or errored; nothing to release.
    }
  }
  return concat(chunks, size)
}

function formBody(audio: AudioBytes, type: string, language: string | undefined): FormData {
  const form = new FormData()
  form.append("file", new Blob([audio], { type }), filenameFor(type))
  form.append("model", MODEL)
  if (language !== undefined) form.append("language", language)
  return form
}

function transcriptText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const text = (payload as { text?: unknown }).text
  if (typeof text !== "string" || text.trim().length === 0) return undefined
  return text
}

function audioTooLarge(c: Context<AppEnv>, maxBytes: number): Response {
  return jsonError(c, 413, "payload_too_large", `Audio must not exceed ${maxBytes} bytes`)
}

/**
 * `POST /api/transcribe` forwards raw audio to the configured STT service as
 * multipart/form-data. The body is streamed in with a byte cap, forwarded from
 * memory, and never written to disk or logged; only the transcript leaves.
 */
export function registerTranscribeRoute(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { config } = deps

  app.post(TRANSCRIBE_PATH, async (c) => {
    const type = audioType(c)
    if (type === undefined) {
      return jsonError(c, 415, "unsupported_media_type", "Content-Type must be audio/*")
    }

    // Reject a declared oversize before reading a single byte.
    const declared = Number(c.req.header("content-length") ?? "")
    if (Number.isFinite(declared) && declared > config.DICTATION_MAX_BYTES) {
      return audioTooLarge(c, config.DICTATION_MAX_BYTES)
    }

    if (!config.STT_URL) {
      return jsonError(c, 503, "stt_unavailable", "Speech-to-text is not configured")
    }

    const audio = await readAudio(c, config.DICTATION_MAX_BYTES)
    if (audio === AUDIO_TOO_LARGE) return audioTooLarge(c, config.DICTATION_MAX_BYTES)
    if (audio.byteLength === 0) {
      return jsonError(c, 400, "invalid_request", "Audio body is empty")
    }

    const upstreamHeaders: Record<string, string> = {}
    if (config.STT_API_KEY) {
      upstreamHeaders.authorization = `Bearer ${config.STT_API_KEY}`
    }

    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.sttTimeoutMs)
    try {
      let upstream: Response
      try {
        upstream = await fetch(upstreamUrl(config.STT_URL), {
          method: "POST",
          headers: upstreamHeaders,
          body: formBody(audio, type, languageHint(c.req.query("language"))),
          signal: controller.signal,
        })
      } catch {
        return controller.signal.aborted
          ? jsonError(c, 504, "stt_timeout", "Speech-to-text timed out")
          : jsonError(c, 502, "stt_failed", "Speech-to-text request failed")
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {})
        return jsonError(c, 502, "stt_failed", "Speech-to-text service returned an error")
      }

      let payload: unknown
      try {
        // The same 30 s deadline covers a stalled response body.
        payload = await upstream.json()
      } catch {
        return controller.signal.aborted
          ? jsonError(c, 504, "stt_timeout", "Speech-to-text timed out")
          : jsonError(c, 502, "stt_failed", "Speech-to-text returned an invalid response")
      }

      const text = transcriptText(payload)
      if (text === undefined) {
        return jsonError(c, 422, "empty_transcript", "Speech-to-text returned no text")
      }

      return c.json({
        text,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      } satisfies TranscriptionResponse)
    } finally {
      clearTimeout(timer)
    }
  })
}
