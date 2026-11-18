/**
 * Manual smoke test for the on-device speech path (issue #47).
 *
 * Run on the host/desktop AFTER `pnpm run stt:fetch`:
 *   pnpm run stt:smoke
 *   pnpm run stt:smoke -- --audio /path/to/sample.wav --expect "Diktat,lokal"
 *
 * It (1) verifies every pinned file's size and SHA-256, (2) runs the real
 * Whisper pipeline on a short German clip through a same-origin-only fetch,
 * (3) prints the transcript and checks the expected words, and (4) fails if a
 * second run causes any fetch at all — the in-memory cache must be warm.
 *
 * On macOS, with no `--audio`, a deterministic clip is synthesized with `say`
 * (no real microphone, no external network):
 *   "Das Diktat läuft lokal im Browser."
 * Expect the transcript to contain "Diktat" and "lokal" (case-insensitive).
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createReadStream, existsSync, readFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  STT_MODEL_CACHE_NAME,
  STT_MODEL_DIR,
  STT_MODEL_FILES,
  STT_MODEL_TOTAL_BYTES,
} from "@openchat/contracts/stt-model"

const SAMPLE_SENTENCE = "Das Diktat läuft lokal im Browser."
const EXPECTED_WORDS = ["Diktat", "lokal"]

export interface VerifyReport {
  files: number
  bytes: number
}

/** Checks the complete pinned set; throws with the first exact mismatch. */
export async function verifyModelFiles(modelDir: string): Promise<VerifyReport> {
  let bytes = 0
  for (const file of STT_MODEL_FILES) {
    const path = join(modelDir, file.path)
    if (!existsSync(path)) throw new Error(`missing model file: ${path} (run pnpm run stt:fetch)`)
    const size = readFileSync(path).byteLength
    if (size !== file.bytes) {
      throw new Error(`size mismatch for ${file.path}: expected ${file.bytes}, got ${size}`)
    }
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array)
    const actual = hash.digest("hex")
    if (actual !== file.sha256) {
      throw new Error(`checksum mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`)
    }
    bytes += size
  }
  return { files: STT_MODEL_FILES.length, bytes }
}

/** Minimal PCM WAV reader for 16-bit mono/stereo clips produced by `say`. */
export function readPcmWav(bytes: Uint8Array): { samples: Float32Array; samplingRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file")
  let offset = 12
  let channels = 0
  let rate = 0
  let data: Uint8Array | null = null
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === "fmt ") {
      channels = view.getUint16(start + 2, true)
      rate = view.getUint32(start + 4, true)
      const bits = view.getUint16(start + 14, true)
      if (bits !== 16) throw new Error("smoke test needs 16-bit PCM WAV audio")
    } else if (id === "data") {
      data = bytes.subarray(start, start + size)
    }
    offset = start + size + (size % 2)
  }
  if (!data || channels === 0 || rate === 0) throw new Error("invalid PCM WAV header")
  const frames = Math.floor(data.byteLength / (2 * channels))
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(data.byteOffset + 2 * (frame * channels + channel), true) / 32768
    }
    samples[frame] = sum / channels
  }
  return { samples, samplingRate: rate }
}

function parseArgs(argv: string[]): { dir: string; audio?: string; expect?: string } {
  let dir = process.env.STT_MODEL_DIR?.trim() || "apps/web/public/models"
  let audio: string | undefined
  let expect: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ""
    if (argument === "--dir") dir = argv[++index] ?? dir
    else if (argument.startsWith("--dir=")) dir = argument.slice("--dir=".length)
    else if (argument === "--audio") audio = argv[++index]
    else if (argument.startsWith("--audio=")) audio = argument.slice("--audio=".length)
    else if (argument === "--expect") expect = argv[++index]
    else if (argument.startsWith("--expect=")) expect = argument.slice("--expect=".length)
    else throw new Error(`unknown argument: ${argument}`)
  }
  return { dir: resolve(dir), audio, expect }
}

function sampleClip(audio?: string): string {
  if (audio) return resolve(audio)
  if (process.platform !== "darwin") {
    throw new Error("no --audio given; supply a 16-bit PCM WAV clip (macOS can synthesize one)")
  }
  const path = join(mkdtempSync(join(tmpdir(), "openchat-stt-smoke-")), "sample.wav")
  execFileSync("say", ["-v", "Anna", "--data-format=LEI16@16000", "-o", path, SAMPLE_SENTENCE])
  return path
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (invokedDirectly) {
  const { dir, audio, expect } = parseArgs(process.argv.slice(2))
  const expected = expect ? expect.split(",").map((word) => word.trim()).filter(Boolean) : EXPECTED_WORDS
  void (async () => {
    const report = await verifyModelFiles(dir)
    console.log(
      `stt:smoke: verified ${report.files} files, ${report.bytes} bytes ` +
        `(manifest ${STT_MODEL_TOTAL_BYTES} bytes)`,
    )
    const clip = sampleClip(audio)
    if (!audio) console.log(`stt:smoke: synthesized clip: "${SAMPLE_SENTENCE}"`)
    const wav = readPcmWav(new Uint8Array(readFileSync(clip)))

    const { env, pipeline } = await import("@huggingface/transformers")
    const fetches: string[] = []
    const memory = new Map<string, Response>()
    env.allowRemoteModels = false
    env.useFS = false
    env.useBrowserCache = false
    env.useFSCache = false
    env.useCustomCache = true
    env.useWasmCache = false
    env.localModelPath = "/models/"
    env.customCache = {
      match: async (key: string) => memory.get(key),
      put: async (key: string, response: Response) => {
        memory.set(key, response.clone())
      },
    }
    env.fetch = async (input: string | URL) => {
      const url = new URL(String(input), "http://localhost/")
      if (url.origin !== "http://localhost" || !url.pathname.startsWith("/models/")) {
        throw new Error(`blocked non-same-origin request in smoke test: ${url}`)
      }
      fetches.push(url.pathname)
      const bytes = readFileSync(join(dir, url.pathname.slice("/models/".length)))
      return new Response(new Uint8Array(bytes), { status: 200 })
    }

    // Node uses ORT's native CPU backend; the browser uses WASM/WebGPU. Both
    // read the same pinned q8 files through the same same-origin-only fetch.
    const run = await pipeline("automatic-speech-recognition", `/models/${STT_MODEL_DIR}`, {
      device: "cpu",
      dtype: "q8",
    })
    const transcribe = run as unknown as (
      samples: Float32Array,
      options: { sampling_rate: number; language: string },
    ) => Promise<{ text: string }>
    const first = await transcribe(wav.samples, { sampling_rate: wav.samplingRate, language: "de" })
    const text = first.text.trim()
    console.log(`stt:smoke: transcript: ${text}`)
    const missing = expected.filter((word) => !text.toLowerCase().includes(word.toLowerCase()))
    if (missing.length > 0) {
      throw new Error(`transcript did not contain: ${missing.join(", ")}`)
    }
    const afterFirst = fetches.length
    await transcribe(wav.samples, { sampling_rate: wav.samplingRate, language: "de" })
    const afterSecond = fetches.length
    console.log(
      `stt:smoke: /models/ fetches first=${afterFirst} second=${afterSecond - afterFirst} ` +
        `(cache: ${STT_MODEL_CACHE_NAME})`,
    )
    if (afterSecond - afterFirst !== 0) {
      throw new Error("second run fetched model files again; versioned cache did not hold")
    }
    console.log("stt:smoke: OK — local transcription works without server STT or external requests")
  })().catch((failure: unknown) => {
    console.error(`stt:smoke: FAILED: ${failure instanceof Error ? failure.message : String(failure)}`)
    process.exitCode = 1
  })
}
