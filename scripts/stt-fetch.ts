/**
 * Operator-time provisioning for the on-device speech model (issue #47).
 *
 * This is the ONLY code allowed to fetch weights, and it is never imported by
 * the browser. It downloads every pinned file from `sttFileUrl`, verifies the
 * SHA-256 and byte count, and resumes an interrupted download from its `.part`
 * file. A checksum mismatch is a hard failure with the exact expected and
 * actual digests; nothing partial is ever moved into place.
 *
 * Usage: pnpm run stt:fetch [--dir <path>] [--base-url <url>]
 */
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  STT_MODEL_DIR,
  STT_MODEL_FILES,
  STT_MODEL_ID,
  STT_MODEL_REVISION,
  STT_MODEL_VERSION,
  sttFileUrl,
  type SttManifestFile,
} from "@openchat/contracts/stt-model"

export interface FetchOptions {
  /** Model root; files are written below it at their manifest paths. */
  destDir: string
  /** Overridable so tests can point at a local HTTP fixture. */
  urlFor: (file: SttManifestFile) => string
  /** Overridable so tests can use a tiny, locally checksummed manifest. */
  files?: readonly SttManifestFile[]
  log?: (message: string) => void
}

export class FetchFailure extends Error {}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array)
  return hash.digest("hex")
}

async function verified(path: string, file: SttManifestFile): Promise<boolean> {
  if (!existsSync(path)) return false
  const info = await stat(path)
  return info.isFile() && info.size === file.bytes && (await sha256(path)) === file.sha256
}

async function downloadOne(
  file: SttManifestFile,
  options: FetchOptions,
  log: (message: string) => void,
): Promise<void> {
  const dest = join(options.destDir, file.path)
  if (await verified(dest, file)) {
    log(`cached   ${file.path}`)
    return
  }
  await mkdir(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  let offset = 0
  if (existsSync(part)) {
    offset = (await stat(part)).size
    if (offset > file.bytes) {
      await unlink(part)
      offset = 0
    }
  }
  const url = options.urlFor(file)
  const headers = offset > 0 ? { range: `bytes=${offset}-` } : undefined
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new FetchFailure(`download failed for ${file.path}: HTTP ${response.status} from ${url}`)
  }
  if (offset > 0 && response.status !== 206) {
    await unlink(part)
    offset = 0
  }
  log(`${offset > 0 ? "resume  " : "download"} ${file.path} (${file.bytes} bytes)`)
  const body = response.body
  if (!body) throw new FetchFailure(`download failed for ${file.path}: empty response body`)
  await pipeline(
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(part, { flags: offset > 0 ? "a" : "w" }),
  )
  const actual = await sha256(part)
  if (actual !== file.sha256) {
    await unlink(part)
    throw new FetchFailure(
      `checksum mismatch for ${file.path}: expected ${file.sha256}, got ${actual}. ` +
        "Delete the file and rerun stt:fetch; do not use this model set.",
    )
  }
  const size = (await stat(part)).size
  if (size !== file.bytes) {
    await unlink(part)
    throw new FetchFailure(`size mismatch for ${file.path}: expected ${file.bytes}, got ${size}`)
  }
  await rename(part, dest)
  log(`ok       ${file.path}`)
}

/** Downloads and verifies the complete pinned model set. */
export async function fetchModel(options: FetchOptions): Promise<void> {
  const log = options.log ?? (() => undefined)
  const files = options.files ?? STT_MODEL_FILES
  log(`model ${STT_MODEL_ID} version ${STT_MODEL_VERSION} (revision ${STT_MODEL_REVISION})`)
  for (const file of files) {
    try {
      await downloadOne(file, options, log)
    } catch (failure) {
      if (failure instanceof FetchFailure) throw failure
      const message = failure instanceof Error ? failure.message : String(failure)
      throw new FetchFailure(`download failed for ${file.path}: ${message}`)
    }
  }
  log("model set complete")
}

function parseArgs(argv: string[]): { dir: string; baseUrl?: string } {
  let dir = process.env.STT_MODEL_DIR?.trim() || "apps/web/public/models"
  let baseUrl: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ""
    if (argument === "--dir") dir = argv[++index] ?? dir
    else if (argument.startsWith("--dir=")) dir = argument.slice("--dir=".length)
    else if (argument === "--base-url") baseUrl = argv[++index]
    else if (argument.startsWith("--base-url=")) baseUrl = argument.slice("--base-url=".length)
    else throw new Error(`unknown argument: ${argument}`)
  }
  return { dir: resolve(dir), baseUrl }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)

if (invokedDirectly) {
  const { dir, baseUrl } = parseArgs(process.argv.slice(2))
  const urlFor = (file: SttManifestFile): string => {
    if (!baseUrl) return sttFileUrl(file)
    const prefix = file.origin === "ort" ? "ort/" : `${STT_MODEL_DIR}/`
    return `${baseUrl.replace(/\/+$/, "")}/${file.path.slice(prefix.length)}`
  }
  fetchModel({ destDir: dir, urlFor, log: (message) => console.log(message) }).catch((failure: unknown) => {
    console.error(`stt:fetch: ${failure instanceof Error ? failure.message : String(failure)}`)
    process.exitCode = 1
  })
}
