/**
 * Pinned, same-origin speech model set for the optional on-device dictation
 * path (issue #47). This module is shared by the BFF (availability check), the
 * provisioning script (download + checksums) and the browser (cache name and
 * the size shown in the consent dialog).
 *
 * There is deliberately no runtime download from a third party. The script
 * `pnpm run stt:fetch` provisions these exact bytes into
 * `apps/web/public/models/`; the BFF serves them from `/models/`.
 */

/** Human-facing model name reported through `/api/info`. */
export const STT_MODEL_ID = "whisper-base"

/** Upstream repository used only by the explicit provisioning step. */
export const STT_MODEL_REPO = "onnx-community/whisper-base"

/** Immutable upstream commit; changing it means a new manifest version. */
export const STT_MODEL_REVISION = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c"

/** Cache-busting version derived from the pinned revision. */
export const STT_MODEL_VERSION = "27a07b4b52b3a4"

/** Versioned Cache Storage name. The service worker never touches this cache. */
export const STT_MODEL_CACHE_NAME = `openchat-stt-${STT_MODEL_VERSION}`

/** Directory below the model root that holds this model's files. */
export const STT_MODEL_DIR = STT_MODEL_ID

/** Pinned ONNX Runtime Web release providing the WASM runtime files. */
export const STT_ORT_VERSION = "1.31.0-dev.20260914-8d85527a0"

export type SttFileOrigin = "model" | "ort"

export interface SttManifestFile {
  /** Path below `apps/web/public/models/`. */
  path: string
  /** SHA-256 of the exact bytes the browser and the smoke test must see. */
  sha256: string
  bytes: number
  origin: SttFileOrigin
}

/**
 * Quantized (`q8`) Whisper base for multilingual dictation, plus the two ONNX
 * Runtime Web binaries (single-threaded `asyncify` for the WASM backend and
 * `jsep` for WebGPU). Upstream URLs are built from REPO/REVISION and the pinned
 * ORT version; nothing here is fetched unless an operator runs `stt:fetch`.
 */
export const STT_MODEL_FILES: readonly SttManifestFile[] = [
  {
    path: `${STT_MODEL_DIR}/config.json`,
    sha256: "f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b",
    bytes: 2243,
    origin: "model",
  },
  {
    path: `${STT_MODEL_DIR}/generation_config.json`,
    sha256: "61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0",
    bytes: 3832,
    origin: "model",
  },
  {
    path: `${STT_MODEL_DIR}/preprocessor_config.json`,
    sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
    bytes: 339,
    origin: "model",
  },
  {
    path: `${STT_MODEL_DIR}/tokenizer.json`,
    sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
    bytes: 2_480_466,
    origin: "model",
  },
  {
    path: `${STT_MODEL_DIR}/tokenizer_config.json`,
    sha256: "2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573",
    bytes: 282_682,
    origin: "model",
  },
  {
    path: `${STT_MODEL_DIR}/onnx/encoder_model_quantized.onnx`,
    sha256: "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46",
    bytes: 23_201_314,
    origin: "model",
  },
  {
    path: `${STT_MODEL_DIR}/onnx/decoder_model_merged_quantized.onnx`,
    sha256: "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b",
    bytes: 53_693_315,
    origin: "model",
  },
  {
    path: "ort/ort-wasm-simd-threaded.asyncify.mjs",
    sha256: "0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611",
    bytes: 53_057,
    origin: "ort",
  },
  {
    path: "ort/ort-wasm-simd-threaded.asyncify.wasm",
    sha256: "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082",
    bytes: 26_861_777,
    origin: "ort",
  },
  {
    path: "ort/ort-wasm-simd-threaded.jsep.mjs",
    sha256: "c2f80e915e9df63289788a99d434d8c4e00e64e9c1f030f4b80b022458dd2c99",
    bytes: 46_851,
    origin: "ort",
  },
  {
    path: "ort/ort-wasm-simd-threaded.jsep.wasm",
    sha256: "62ff86b2f2fa3a79eb87a7e4720e8ea9051942bf975f314181bf7dcef2feac06",
    bytes: 28_352_885,
    origin: "ort",
  },
]

/** Exact download size shown before the user consents to the first download. */
export const STT_MODEL_TOTAL_BYTES = STT_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0)

/** Absolute URL used by the operator-time downloader (never by the browser). */
export function sttFileUrl(file: SttManifestFile): string {
  if (file.origin === "ort") {
    return (
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${STT_ORT_VERSION}/dist/` +
      file.path.slice("ort/".length)
    )
  }
  return (
    `https://huggingface.co/${STT_MODEL_REPO}/resolve/${STT_MODEL_REVISION}/` +
    file.path.slice(`${STT_MODEL_DIR}/`.length)
  )
}

/** Cache key for one file, stable across page loads and worker restarts. */
export function sttCacheKey(path: string): string {
  return `/models/${path}`
}
