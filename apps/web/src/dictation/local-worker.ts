/**
 * On-device speech worker (issue #47).
 *
 * Transformers.js is imported dynamically on the first consented action, so it
 * never reaches the entry bundle. Every byte the pipeline reads goes through
 * the same-origin, versioned-cache fetch installed by `createMessageHandler`;
 * `allowRemoteModels` is off, so Hugging Face is unreachable at runtime.
 */
import {
  createMessageHandler,
  type FetchLike,
  type LocalDevice,
  type PipelineOptions,
  type Transcriber,
  type WorkerDeps,
  type WorkerRequest,
} from "./local-protocol"

interface OnnxEnvShape {
  wasm?: {
    wasmPaths?: { mjs: string; wasm: string }
    proxy?: boolean
  }
}

/** Pinned local runtime files; no CDN is consulted for the WASM backend. */
function wasmPaths(device: LocalDevice): { mjs: string; wasm: string } {
  const suffix = device === "webgpu" ? "jsep" : "asyncify"
  return {
    mjs: `/models/ort/ort-wasm-simd-threaded.${suffix}.mjs`,
    wasm: `/models/ort/ort-wasm-simd-threaded.${suffix}.wasm`,
  }
}

async function createPipeline(options: PipelineOptions): Promise<Transcriber> {
  const { env, pipeline } = await import("@huggingface/transformers")
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = "/models/"
  // Our own cache is the only cache: Transformers.js' browser cache is off so
  // it cannot keep a second, unversioned copy of the weights.
  env.useBrowserCache = false
  env.useFSCache = false
  env.useCustomCache = false
  env.useWasmCache = true
  env.fetch = options.fetcher as typeof env.fetch
  // `env.backends.onnx` is a shallow copy of the runtime env: its nested
  // `wasm` object is shared, so it must be mutated in place (replacing it
  // would silently leave the CDN default in ONNX Runtime).
  const onnx = env.backends.onnx as OnnxEnvShape
  const wasm = (onnx.wasm ??= {})
  wasm.wasmPaths = wasmPaths(options.device)
  wasm.proxy = false

  const created = await pipeline("automatic-speech-recognition", options.modelPath, {
    device: options.device,
    dtype: "q8",
  })
  const run = created as unknown as (
    samples: Float32Array,
    options: { sampling_rate: number; language: string; task: string },
  ) => Promise<{ text: string }>
  return async (samples, callOptions) =>
    run(samples, { ...callOptions, task: "transcribe" })
}

const scope = self as unknown as {
  postMessage(message: Parameters<WorkerDeps["post"]>[0]): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
const post = (message: Parameters<WorkerDeps["post"]>[0]): void => scope.postMessage(message)

// `"gpu" in navigator` is not enough: headless and virtualized browsers expose
// navigator.gpu but cannot supply an adapter. Asking Transformers.js for a
// WebGPU session it cannot create poisons the ONNX backend, so a later WASM
// retry fails with the same error. Probe once before selecting a device.
let webGpuAvailable = false
let deviceProbed = false
async function probeDevice(): Promise<void> {
  if (deviceProbed) return
  deviceProbed = true
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return
  try {
    webGpuAvailable = (await gpu.requestAdapter()) != null
  } catch {
    webGpuAvailable = false
  }
}

const deps: WorkerDeps = {
  createPipeline,
  fetchFile: ((input, init) => fetch(input, init)) as FetchLike,
  openCache: async (name) => {
    const cache = await caches.open(name)
    return {
      match: async (key) => (await cache.match(key)) ?? undefined,
      put: async (key, response) => cache.put(key, response),
    }
  },
  post,
  now: () => performance.now(),
  hasWebGpu: () => webGpuAvailable,
  hasWebAssembly: () => typeof WebAssembly === "object",
}

const handle = createMessageHandler(deps)
scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void probeDevice().then(() => handle(event.data))
}
