/**
 * Message protocol between the composer and the speech worker (issue #47).
 *
 * The protocol is deliberately tiny: the main thread sends `load` (consented
 * download) or `transcribe`, and the worker answers `ready`, `progress`,
 * `result` or `error`. Errors are stable codes only — no stack traces cross
 * the worker boundary. This module is free of browser globals so unit tests
 * can drive it with a stubbed pipeline, a stubbed fetch and an in-memory cache.
 */
import {
  STT_MODEL_DIR,
  STT_MODEL_FILES,
  sttCacheKey,
} from "@openchat/contracts"

export type LocalErrorCode =
  | "model_unavailable"
  | "model_download_failed"
  | "out_of_memory"
  | "empty_transcript"
  | "unsupported"

export type LocalDevice = "webgpu" | "wasm"

export type WorkerRequest =
  | { type: "load"; cacheName: string }
  | {
      type: "transcribe"
      cacheName: string
      samples: Float32Array
      samplingRate: number
      language: string
    }

export type WorkerResponse =
  | { type: "ready"; device: LocalDevice }
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "result"; text: string; durationMs: number }
  | { type: "error"; code: LocalErrorCode }

export interface LocalProgress {
  file: string
  loaded: number
  total: number
}

export interface LocalResult {
  text: string
  durationMs: number
}

export interface PipelineOptions {
  device: LocalDevice
  modelPath: string
  /** The only fetch Transformers.js may use; cache-backed and same-origin. */
  fetcher: FetchLike
}

export interface Transcriber {
  (samples: Float32Array, options: { sampling_rate: number; language: string }): Promise<{
    text: string
  }>
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface CacheLike {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<unknown>
}

export interface WorkerDeps {
  createPipeline(options: PipelineOptions): Promise<Transcriber>
  fetchFile: FetchLike
  openCache(name: string): Promise<CacheLike>
  post(message: WorkerResponse): void
  now(): number
  hasWebGpu(): boolean
  hasWebAssembly(): boolean
}

/** Files whose absence is mapped to `model_unavailable`, never a stack trace. */
export function modelFilePaths(): string[] {
  return STT_MODEL_FILES.map((file) => sttCacheKey(file.path))
}

function errorCode(failure: unknown): LocalErrorCode {
  if (failure instanceof Error) {
    if (failure.name === "AbortError") return "model_unavailable"
    const message = failure.message.toLowerCase()
    if (message.includes("out of memory") || message.includes("oom") || message.includes("allocation")) {
      return "out_of_memory"
    }
    if (message.includes("unsupported-url") || message.includes("webassembly is not supported")) {
      return "unsupported"
    }
    if (message.includes("http-404") || message.includes("http-403") || message.includes("missing")) {
      return "model_unavailable"
    }
    if (message.includes("quota") || message.includes("network") || message.includes("fetch")) {
      return "model_download_failed"
    }
  }
  return "model_unavailable"
}

/**
 * Builds the worker message handler. `installFetch` is the only door through
 * which Transformers.js may read bytes: it admits same-origin `/models/`
 * paths, serves them from the versioned Cache Storage first, and streams a
 * download with progress only on a cache miss.
 */
export function createMessageHandler(deps: WorkerDeps) {
  let transcriber: Transcriber | null = null
  let activeCacheName = ""
  let activeDevice: LocalDevice = "wasm"

  async function ensurePipeline(cacheName: string, device: LocalDevice): Promise<void> {
    if (transcriber && activeCacheName === cacheName) return

    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(String(input), globalThis.location?.href ?? "http://localhost/")
      if (url.origin !== globalThis.location?.origin || !url.pathname.startsWith("/models/")) {
        throw new Error("unsupported-url: only same-origin /models/ files are allowed")
      }
      const key = `${url.pathname}${url.search}`
      const cache = await deps.openCache(cacheName)
      const hit = await cache.match(key)
      if (hit) return hit

      const response = await deps.fetchFile(url, init)
      if (!response.ok) throw new Error(`http-${response.status}: ${key}`)
      if (response.headers.get("content-range")) return response

      const reader = response.body?.getReader()
      if (!reader) {
        await cache.put(key, response.clone())
        return response
      }
      const chunks: Uint8Array[] = []
      let loaded = 0
      const total = Number(response.headers.get("content-length") ?? 0) || 0
      const file = url.pathname.split("/").pop() ?? key
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.byteLength
        deps.post({ type: "progress", file, loaded, total })
      }
      const bytes = new Uint8Array(loaded)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const buffered = new Response(bytes, {
        status: response.status,
        headers: response.headers,
      })
      await cache.put(key, buffered.clone())
      return buffered
    }

    let lastFailure: unknown
    const devices: LocalDevice[] = device === "webgpu" ? ["webgpu", "wasm"] : ["wasm"]
    for (const candidate of devices) {
      try {
        transcriber = await deps.createPipeline({
          device: candidate,
          modelPath: `/models/${STT_MODEL_DIR}`,
          fetcher,
        })
        activeCacheName = cacheName
        activeDevice = candidate
        return
      } catch (failure) {
        lastFailure = failure
      }
    }
    throw lastFailure ?? new Error("model_unavailable")
  }

  return async function handle(request: WorkerRequest): Promise<void> {
    try {
      if (request.type === "load") {
        if (!deps.hasWebAssembly() && !deps.hasWebGpu()) {
          throw new Error("unsupported: WebAssembly is not supported here")
        }
        await ensurePipeline(request.cacheName, deps.hasWebGpu() ? "webgpu" : "wasm")
        deps.post({ type: "ready", device: activeDevice })
        return
      }
      const started = deps.now()
      await ensurePipeline(request.cacheName, deps.hasWebGpu() ? "webgpu" : "wasm")
      const output = await (transcriber as Transcriber)(request.samples, {
        sampling_rate: request.samplingRate,
        language: request.language,
      })
      const text = typeof output?.text === "string" ? output.text.trim() : ""
      if (text.length === 0) {
        deps.post({ type: "error", code: "empty_transcript" })
        return
      }
      deps.post({ type: "result", text, durationMs: Math.max(0, Math.round(deps.now() - started)) })
    } catch (failure) {
      deps.post({ type: "error", code: errorCode(failure) })
    }
  }
}
