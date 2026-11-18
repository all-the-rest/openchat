import { readFile, realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve } from "node:path"
import { STT_MODEL_FILES, type SttManifestFile } from "@openchat/contracts"

/**
 * Read-only static origin for the pinned on-device speech model (issue #47).
 *
 * Weights are provisioned by `pnpm run stt:fetch` into `STT_MODEL_DIR` and
 * served same-origin under `/models/`. The browser never contacts a third
 * party at runtime. Only GET/HEAD reach the filesystem, every resolved path is
 * confined to the model root, and a missing file is a plain 404 rather than a
 * fall-through to the SPA shell.
 */

/** Environment variable naming the pinned model root. */
export const STT_MODEL_DIR_ENV = "STT_MODEL_DIR"

/** Path prefix the browser uses for the model files. */
export const STT_MODEL_PATH_PREFIX = "/models/"

/** Relative default, resolved against the process working directory. */
export const DEFAULT_STT_MODEL_DIR = "apps/web/public/models"

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".wasm": "application/wasm",
}

/**
 * Reads `STT_MODEL_DIR`. A relative value resolves against the working
 * directory; an empty value falls back to the shipped project path.
 */
export function sttModelDir(source: Record<string, string | undefined> = process.env): string {
  const value = source[STT_MODEL_DIR_ENV]?.trim()
  return resolve(value && value.length > 0 ? value : DEFAULT_STT_MODEL_DIR)
}

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * A model is advertised as available only when the complete pinned set is
 * present. A partial download must never enable the on-device path.
 */
export async function localModelAvailable(modelDir: string): Promise<boolean> {
  const results = await Promise.all(
    STT_MODEL_FILES.map((file) => isRegularFile(resolve(modelDir, file.path))),
  )
  return results.every(Boolean)
}

/** Missing manifest files, reported by the smoke test and the fetch script. */
export async function missingModelFiles(modelDir: string): Promise<SttManifestFile[]> {
  const checks = await Promise.all(
    STT_MODEL_FILES.map(async (file) => ({
      file,
      present: await isRegularFile(resolve(modelDir, file.path)),
    })),
  )
  return checks.filter((check) => !check.present).map((check) => check.file)
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: "not_found", message: "Model file not found" } }), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

/**
 * Resolves a `/models/<file>` request inside `modelDir`, or returns undefined
 * for anything else. `..`, absolute paths and NUL bytes are rejected before
 * the filesystem lookup; `realpath` additionally defeats symlink escapes.
 */
async function modelFileWithin(modelDir: string, pathname: string): Promise<string | undefined> {
  if (pathname.includes("\u0000")) return undefined
  if (!pathname.startsWith(STT_MODEL_PATH_PREFIX)) return undefined
  const requestPath = pathname.slice(STT_MODEL_PATH_PREFIX.length)
  if (requestPath.length === 0 || requestPath.startsWith("/")) return undefined
  const decoded = decodeURIComponent(requestPath)
  if (decoded.includes("\u0000") || isAbsolute(decoded)) return undefined
  const root = await realpath(modelDir).catch(() => undefined)
  if (!root) return undefined
  const target = resolve(root, decoded)
  const within = relative(root, target)
  if (within.startsWith("..") || isAbsolute(within)) return undefined
  const real = await realpath(target).catch(() => undefined)
  if (!real) return undefined
  const realWithin = relative(root, real)
  if (realWithin.startsWith("..") || isAbsolute(realWithin)) return undefined
  return real
}

/**
 * Answers a `GET`/`HEAD` for a pinned model file. Returns undefined when the
 * request is not for `/models/`, and a 404 when it is but the file is absent.
 */
export async function serveModelFile(modelDir: string, request: Request): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname)
  } catch {
    return undefined
  }
  if (!pathname.startsWith(STT_MODEL_PATH_PREFIX)) return undefined

  const file = await modelFileWithin(modelDir, pathname)
  if (!file || !(await isRegularFile(file))) return notFound()

  const head = request.method === "HEAD"
  const body = head ? null : await readFile(file)
  return new Response(body ? new Uint8Array(body) : null, {
    status: 200,
    headers: {
      "content-type": contentType(file),
      "content-length": String(body?.byteLength ?? (await stat(file)).size),
      "cache-control": IMMUTABLE_CACHE,
      "x-content-type-options": "nosniff",
    },
  })
}
