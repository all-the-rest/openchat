import { describe, expect, it, vi } from "vitest"
import {
  createMessageHandler,
  type CacheLike,
  type FetchLike,
  type PipelineOptions,
  type Transcriber,
  type WorkerDeps,
  type WorkerResponse,
} from "../src/dictation/local-protocol"

const BASE = new URL("/", globalThis.location?.href ?? "http://localhost:3000/").origin
const url = (path: string) => `${BASE}${path}`

function harness(overrides: Partial<WorkerDeps> = {}) {
  const messages: WorkerResponse[] = []
  const cache = new Map<string, Response>()
  const cacheLike: CacheLike = {
    match: async (key) => cache.get(key),
    put: async (key, response) => void cache.set(key, response),
  }
  const fetchFile = vi.fn<FetchLike>(async (input) => {
    const path = new URL(String(input), BASE).pathname
    return new Response(new TextEncoder().encode(`bytes:${path}`), {
      status: 200,
      headers: { "content-length": String(9 + path.length) },
    })
  })
  let installed: FetchLike | null = null
  const createPipeline = vi.fn(async (options: PipelineOptions): Promise<Transcriber> => {
    installed = options.fetcher
    await options.fetcher(url("/models/whisper-base/config.json"))
    return async () => ({ text: "Das Diktat läuft lokal." })
  })
  const deps: WorkerDeps = {
    createPipeline,
    fetchFile,
    openCache: async () => cacheLike,
    post: (message) => messages.push(message),
    now: () => 1000,
    hasWebGpu: () => false,
    hasWebAssembly: () => true,
    ...overrides,
  }
  return { deps, messages, cache, fetchFile, createPipeline, getFetch: () => installed }
}

describe("speech worker protocol", () => {
  it("streams progress, caches bytes, emits ready and never refetches", async () => {
    const h = harness()
    const handle = createMessageHandler(h.deps)
    await handle({ type: "load", cacheName: "openchat-stt-v1" })
    await handle({ type: "load", cacheName: "openchat-stt-v1" })

    expect(h.messages.filter((m) => m.type === "ready")).toHaveLength(2)
    expect(h.messages.some((m) => m.type === "progress")).toBe(true)
    expect(h.fetchFile).toHaveBeenCalledTimes(1)
    expect(h.cache.has("/models/whisper-base/config.json")).toBe(true)
  })

  it("transcribes through the pipeline and returns a stable result", async () => {
    const h = harness()
    const handle = createMessageHandler(h.deps)
    await handle({
      type: "transcribe",
      cacheName: "openchat-stt-v1",
      samples: new Float32Array([0, 0.5, 0]),
      samplingRate: 16000,
      language: "de",
    })
    expect(h.messages.at(-1)).toEqual({
      type: "result",
      text: "Das Diktat läuft lokal.",
      durationMs: 0,
    })
  })

  it("maps a missing model file to model_unavailable without a stack trace", async () => {
    const h = harness({
      fetchFile: vi.fn(async () => new Response("missing", { status: 404 })),
    })
    await createMessageHandler(h.deps)({ type: "load", cacheName: "v1" })
    expect(h.messages.at(-1)).toEqual({ type: "error", code: "model_unavailable" })
    expect(JSON.stringify(h.messages)).not.toContain("at ")
  })

  it("maps an allocation failure to out_of_memory", async () => {
    const h = harness({
      createPipeline: vi.fn(async () => {
        throw new Error("WebAssembly.Memory: out of memory allocation")
      }),
    })
    await createMessageHandler(h.deps)({ type: "load", cacheName: "v1" })
    expect(h.messages.at(-1)).toEqual({ type: "error", code: "out_of_memory" })
  })

  it("blocks a third-party fetch from the pipeline", async () => {
    const h = harness({
      createPipeline: vi.fn(async (options: PipelineOptions) => {
        await options.fetcher("https://huggingface.co/onnx-community/whisper-base/config.json")
        return async () => ({ text: "unreachable" })
      }),
    })
    await createMessageHandler(h.deps)({ type: "load", cacheName: "v1" })
    expect(h.messages.at(-1)).toEqual({ type: "error", code: "unsupported" })
    expect(h.fetchFile).not.toHaveBeenCalled()
  })

  it("reports unsupported when neither WebAssembly nor WebGPU exists", async () => {
    const h = harness({ hasWebAssembly: () => false, hasWebGpu: () => false })
    await createMessageHandler(h.deps)({ type: "load", cacheName: "v1" })
    expect(h.messages.at(-1)).toEqual({ type: "error", code: "unsupported" })
  })

  it("falls back to WASM when the WebGPU session cannot be created", async () => {
    const createPipeline = vi.fn(async (options: PipelineOptions) => {
      if (options.device === "webgpu") throw new Error("Failed to get GPU adapter")
      return async () => ({ text: "Lokales Diktat." })
    })
    const h = harness({ hasWebGpu: () => true, createPipeline })
    await createMessageHandler(h.deps)({ type: "load", cacheName: "v1" })
    expect(h.messages.at(-1)).toEqual({ type: "ready", device: "wasm" })
    expect(createPipeline).toHaveBeenCalledTimes(2)
  })
})
