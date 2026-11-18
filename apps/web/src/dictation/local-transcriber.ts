/**
 * Main-thread side of the on-device transcription path (issue #47). This
 * module itself is dynamically imported by the controller, and the worker it
 * creates is a Vite worker chunk — Transformers.js never enters the entry
 * bundle. The session is reusable, so a second recording reuses the loaded
 * pipeline and reads weights from the versioned cache with no network.
 */
import type {
  LocalProgress,
  LocalResult,
  WorkerRequest,
  WorkerResponse,
} from "./local-protocol"

export type { LocalProgress, LocalResult } from "./local-protocol"

/** Stable failure carrying a protocol error code, never a stack trace. */
export class LocalFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "LocalFailure"
  }
}

export interface LocalSessionCallbacks {
  onReady?(): void
  onProgress?(progress: LocalProgress): void
}

export interface LocalSession {
  /** Consented first load: downloads and caches the model, then signals ready. */
  load(): Promise<void>
  /** Decodes the recording on the main thread and transcribes it in the worker. */
  transcribe(audio: Blob, language: string): Promise<LocalResult>
  /** Terminates the worker and settles any in-flight request. */
  cancel(): void
}

type Pending = {
  expect: "ready" | "result"
  resolve(value: LocalResult | void): void
  reject(failure: Error): void
}

interface AudioSamples {
  samples: Float32Array
  samplingRate: number
}

/**
 * Decodes the recorded blob to mono PCM at Whisper's native 16 kHz. Decoding
 * at the device rate and letting the extractor resample a second time measurably
 * degrades whisper-base; requesting 16 kHz up front keeps the transcript stable.
 * Browsers that reject a custom rate fall back to their default context.
 */
async function decodeAudio(audio: Blob): Promise<AudioSamples> {
  const scope = globalThis as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (!Ctor) throw new LocalFailure("unsupported")
  let context: AudioContext
  try {
    context = new Ctor({ sampleRate: 16000 })
  } catch {
    context = new Ctor()
  }
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer())
    const frames = decoded.length
    const samples = new Float32Array(frames)
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel)
      for (let frame = 0; frame < frames; frame += 1) {
        samples[frame] = (samples[frame] ?? 0) + (data[frame] ?? 0)
      }
    }
    if (decoded.numberOfChannels > 1) {
      for (let frame = 0; frame < frames; frame += 1) {
        samples[frame] = (samples[frame] ?? 0) / decoded.numberOfChannels
      }
    }
    return { samples, samplingRate: decoded.sampleRate }
  } finally {
    void context.close().catch(() => undefined)
  }
}

export function createLocalSession(
  cacheName: string,
  callbacks: LocalSessionCallbacks = {},
): LocalSession {
  let worker: Worker | null = null
  let pending: Pending | null = null
  let loadPromise: Promise<void> | null = null

  function settle(failure: Error): void {
    const active = pending
    pending = null
    active?.reject(failure)
  }

  function ensureWorker(): Worker {
    if (worker) return worker
    const created = new Worker(new URL("./local-worker.ts", import.meta.url), { type: "module" })
    created.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.type === "progress") {
        callbacks.onProgress?.({ file: message.file, loaded: message.loaded, total: message.total })
        return
      }
      if (message.type === "ready") {
        callbacks.onReady?.()
        if (pending?.expect === "ready") {
          const active = pending
          pending = null
          active.resolve(undefined)
        }
        return
      }
      if (message.type === "result") {
        if (pending?.expect === "result") {
          const active = pending
          pending = null
          active.resolve({ text: message.text, durationMs: message.durationMs })
        }
        return
      }
      settle(new LocalFailure(message.code))
    }
    created.onerror = () => settle(new LocalFailure("model_unavailable"))
    worker = created
    return created
  }

  function send(request: WorkerRequest, expect: "ready" | "result"): Promise<LocalResult | void> {
    if (pending) settle(new LocalFailure("model_unavailable"))
    return new Promise<LocalResult | void>((resolve, reject) => {
      pending = { expect, resolve, reject }
      ensureWorker().postMessage(request)
    })
  }

  function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = send({ type: "load", cacheName }, "ready").then(() => undefined)
    return loadPromise
  }

  return {
    load,

    async transcribe(audio: Blob, language: string): Promise<LocalResult> {
      await load()
      const decoded = await decodeAudio(audio)
      const request: WorkerRequest = {
        type: "transcribe",
        cacheName,
        samples: decoded.samples,
        samplingRate: decoded.samplingRate,
        language,
      }
      const result = await send(request, "result")
      return result as LocalResult
    },

    cancel(): void {
      settle(new LocalFailure("model_unavailable"))
      worker?.terminate()
      worker = null
      loadPromise = null
    },
  }
}
