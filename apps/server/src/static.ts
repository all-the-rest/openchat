import { readFile, stat } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"

/**
 * Production static origin for the built web app.
 *
 * The BFF is the only browser-facing role in a deployment (architecture 03):
 * it serves `apps/web/dist` next to `/api/*` on the same origin. In development
 * Vite serves the shell and proxies `/api`, so this module is inert unless
 * `WEB_DIST_DIR` names an existing build.
 *
 * The shell itself is public: `/login` and the app boot are part of the SPA and
 * the API enforces authentication. Anything that names the API or `/healthz`
 * as its first segment never reaches the filesystem.
 */

/** Environment variable naming the built SPA directory. Empty disables it. */
export const WEB_DIST_ENV = "WEB_DIST_DIR"

/** Vite emits content-hashed files below `assets/`; they never change name. */
const IMMUTABLE_PREFIX = "/assets/"
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
const SHELL_CACHE = "no-store"

/** First segments the application owns; a file of that name must not shadow them. */
const RESERVED_SEGMENTS = new Set(["api", "healthz"])

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

/** A path segment that can only be a file reference, never an SPA route. */
const LOOKS_LIKE_FILE = /\.[A-Za-z0-9]+$/

export interface WebDistOptions {
  /** Directory holding the Vite build. Injected so tests can use a fixture. */
  distDir: string
}

/**
 * Reads `WEB_DIST_DIR`. A relative value is resolved against the working
 * directory; an empty or blank value disables static serving.
 */
export function webDistDir(
  source: Record<string, string | undefined> = process.env,
): string {
  const value = source[WEB_DIST_ENV]
  if (value === undefined) return ""
  const trimmed = value.trim()
  return trimmed.length > 0 ? resolve(trimmed) : ""
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase()
  return CONTENT_TYPES[extension] ?? "application/octet-stream"
}

function cacheControl(pathname: string): string {
  return pathname.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE_CACHE : SHELL_CACHE
}

/**
 * The first non-empty path segment, lower-cased. `//API/info`, `/Api` and
 * `/healthz/` all name a reserved route: repeated leading slashes and casing are
 * URL spelling, not a different resource. Only this check folds case; the
 * filesystem lookup below still uses the exact decoded path.
 */
function firstSegment(pathname: string): string {
  for (const segment of pathname.split("/")) {
    if (segment.length > 0) return segment.toLowerCase()
  }
  return ""
}

async function readFileOrUndefined(path: string): Promise<Buffer | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    return await readFile(path)
  } catch {
    return undefined
  }
}

function buildResponse(pathname: string, file: string, body: Buffer, head: boolean): Response {
  const headers: Record<string, string> = {
    "content-type": contentType(file),
    "content-length": String(body.byteLength),
    "cache-control": cacheControl(pathname),
    "x-content-type-options": "nosniff",
  }
  return new Response(head ? null : new Uint8Array(body), { status: 200, headers })
}

/**
 * Maps a request path onto `distDir`, or returns `undefined` when the file must
 * not be served. `resolve` normalises `..`, and the prefix check rejects
 * anything that climbed out of the directory as well as a sibling whose name
 * merely starts with the same characters.
 */
function fileWithin(distDir: string, pathname: string): string | undefined {
  if (pathname.includes("\u0000")) return undefined
  const target = resolve(distDir, `.${pathname}`)
  if (target !== distDir && !target.startsWith(`${distDir}${sep}`)) return undefined
  return target
}

/**
 * Answers a `GET`/`HEAD` from the build, or `undefined` so the caller can fall
 * through to the application (API routes, JSON 404). Only `GET`/`HEAD` are
 * considered, and a reserved first segment is never resolved against the
 * filesystem.
 */
export async function serveStatic(
  options: WebDistOptions,
  request: Request,
): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname)
  } catch {
    return undefined
  }

  if (RESERVED_SEGMENTS.has(firstSegment(pathname))) return undefined

  const target = fileWithin(options.distDir, pathname)
  if (target === undefined) return undefined

  const head = request.method === "HEAD"
  const direct = await readFileOrUndefined(target)
  if (direct) return buildResponse(pathname, target, direct, head)

  // A missing file with an extension is a real 404, not an SPA route: an
  // absent `/assets/app.js` must not answer `index.html`.
  if (LOOKS_LIKE_FILE.test(pathname)) return undefined

  const shell = await readFileOrUndefined(resolve(options.distDir, "index.html"))
  if (!shell) return undefined
  return buildResponse("/", resolve(options.distDir, "index.html"), shell, head)
}
