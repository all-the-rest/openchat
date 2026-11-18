/**
 * Build-output gate: the web bundle's splitting contract (ceiling, issue #26).
 *
 * Reads a finished `apps/web/dist` (including `.vite/manifest.json`) and counts
 * violations of the contract:
 *
 * - no JavaScript chunk larger than 500 kB before gzip, except chunks only the
 *   lazily imported Mermaid graph can reach (its ELK layout is ~1.5 MB and is
 *   fetched only when a diagram renders);
 * - every non-login route is a dynamic import of the entry, so the initial
 *   payload stays the login/landing shell;
 * - `LoginPage` and `LandingPage` are *not* dynamic entries: they are the first
 *   paint and belong to the entry chunk;
 * - the entry chunk itself stays under the budget, so renderer dependencies
 *   (Markdown, KaTeX, highlight.js) cannot creep back into the initial payload.
 *
 * The Mermaid exemption is computed from the manifest graph, not from a name
 * list: a chunk is exempt when it is reachable from `mermaid.core` but not from
 * the entry's static imports. Renaming or adding a diagram chunk therefore
 * needs no change here.
 *
 * Default mode is the gate: silent and exit 0 for a compliant build, one line
 * per violation on stderr and exit 1 otherwise. `--list` prints the machine
 * table (`<bytes>\t<file>\t<reason>`) for humans and tests. `--root <dir>`
 * points the read at another tree; the tests use it with a temporary fixture.
 *
 * A missing build is an error (exit 2), not a pass: the caller must produce
 * `apps/web/dist` first. `apps/web`'s build script runs this check directly
 * after `vite build`, so `gates:fast` and CI never build twice.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))

/** Raw (uncompressed) bytes one chunk may occupy after minification. */
export const LIMIT = 500_000

/** Build output, relative to the repository root. */
export const DIST = "apps/web/dist"

export const MANIFEST = ".vite/manifest.json"

/** Route modules that must arrive as their own lazy chunk. */
export const LAZY_ROUTES = [
  "src/pages/ChatPage.tsx",
  "src/search/SearchPage.tsx",
  "src/code/CodePage.tsx",
  "src/apps/AppsPage.tsx",
  "src/artifacts/ArtifactsPage.tsx",
  "src/artifacts/ArtifactViewer.tsx",
]

/** First-paint route modules that must stay in the eager entry chunk. */
export const EAGER_ROUTES = ["src/pages/LoginPage.tsx", "src/pages/LandingPage.tsx"]

export interface ManifestChunk {
  file: string
  src?: string
  isEntry?: boolean
  isDynamicEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  assets?: string[]
}

export type Manifest = Record<string, ManifestChunk>

export interface Violation {
  bytes: number
  file: string
  reason: string
}

export function readManifest(distDir: string): Manifest {
  const path = join(distDir, MANIFEST)
  return JSON.parse(readFileSync(path, "utf8")) as Manifest
}

/** Manifest references are keys; fall back to a file path for older formats. */
export function resolveKey(manifest: Manifest, reference: string): string | undefined {
  if (manifest[reference]) return reference
  return Object.keys(manifest).find((key) => manifest[key]?.file === reference)
}

/**
 * Files reachable from `roots`. Static imports always count; dynamic imports
 * only when `dynamic` is set, which is how the Mermaid graph is walked.
 * Chunks in `stop` are recorded but not expanded: the entry's own dynamic
 * imports are the route graph, not part of whatever reached the entry.
 */
export function reach(
  manifest: Manifest,
  roots: string[],
  dynamic: boolean,
  stop: Set<string> = new Set(),
): Set<string> {
  const keys = reachKeys(manifest, roots, dynamic, stop)
  return new Set([...keys].map((key) => manifest[key]?.file).filter((file) => file !== undefined))
}

function reachKeys(
  manifest: Manifest,
  roots: string[],
  dynamic: boolean,
  stop: Set<string>,
): Set<string> {
  const seen = new Set<string>()
  const queue = [...roots]

  while (queue.length > 0) {
    const reference = queue.pop()
    if (reference === undefined) continue
    const key = resolveKey(manifest, reference)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)

    const chunk = manifest[key]
    if (chunk === undefined || stop.has(key)) continue

    const references = [...(chunk.imports ?? []), ...(dynamic ? (chunk.dynamicImports ?? []) : [])]
    for (const next of references) queue.push(next)
  }

  return seen
}

/** Manifest keys of the lazily loaded Mermaid entry points. */
export function mermaidRoots(manifest: Manifest): string[] {
  return Object.keys(manifest).filter((key) => {
    const source = manifest[key]?.src ?? key
    return /[\\/]mermaid[\\/]dist[\\/]mermaid\.core\.[cm]?js$/.test(source)
  })
}

function entryKeys(manifest: Manifest): string[] {
  return Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true)
}

function oversizedChunk(
  distDir: string,
  file: string,
  exempt: Set<string>,
): Violation | null {
  if (!/\.m?js$/.test(file) || exempt.has(file)) return null
  const path = join(distDir, file)
  if (!existsSync(path)) return null
  const bytes = statSync(path).size
  if (bytes <= LIMIT) return null
  return { bytes, file, reason: `over ${LIMIT} bytes` }
}

/** Contract violations in the build at `root`. */
export function violations(root: string): Violation[] {
  const distDir = join(root, DIST)
  const manifest = readManifest(distDir)

  const entries = entryKeys(manifest)
  const entry = entries.length === 1 ? manifest[entries[0] as string] : undefined
  const eagerKeys = reachKeys(manifest, entries, false, new Set())
  const eager = new Set(
    [...eagerKeys].map((key) => manifest[key]?.file).filter((file) => file !== undefined),
  )
  const mermaid = reach(manifest, mermaidRoots(manifest), true, eagerKeys)
  const exempt = new Set([...mermaid].filter((file) => !eager.has(file)))

  const found: Violation[] = []

  if (entry === undefined) {
    found.push({
      bytes: 0,
      file: "index.html",
      reason: `expected exactly one entry chunk, found ${entries.length}`,
    })
  }

  const files = new Set(Object.values(manifest).map((chunk) => chunk.file))
  for (const file of files) {
    const violation = oversizedChunk(distDir, file, exempt)
    if (violation) found.push(violation)
  }

  for (const route of LAZY_ROUTES) {
    const chunk = manifest[route]
    const direct = entry?.dynamicImports?.includes(route) === true
    if (chunk?.isDynamicEntry !== true || !direct) {
      found.push({
        bytes: 0,
        file: route,
        reason: "route must be a dynamic import of the entry (lazy chunk)",
      })
    }
  }

  for (const route of EAGER_ROUTES) {
    if (manifest[route]?.isDynamicEntry === true) {
      found.push({
        bytes: 0,
        file: route,
        reason: "first-paint route must stay in the eager entry chunk",
      })
    }
  }

  // Issue #47: the speech worker is a lazy asset and its ONNX runtime must
  // never be inlined into the first-paint JavaScript.
  if (entry !== undefined) {
    if (!(entry.assets ?? []).some((asset) => /local-worker-.*\.js$/.test(asset))) {
      found.push({
        bytes: 0,
        file: "assets/local-worker-*.js",
        reason: "speech worker must be a lazy asset of the entry",
      })
    }
    const entryPath = join(distDir, entry.file)
    if (existsSync(entryPath)) {
      const source = readFileSync(entryPath, "utf8")
      if (/onnxruntime|@huggingface\/transformers/.test(source)) {
        found.push({
          bytes: 0,
          file: entry.file,
          reason: "model runtime must not enter the entry chunk",
        })
      }
    }
  }

  return found.sort((left, right) => left.file.localeCompare(right.file))
}

interface Options {
  root: string
  list: boolean
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function options(argv: string[]): Options {
  let root = ROOT
  let list = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ""
    if (argument === "--list") list = true
    else if (argument === "--root") {
      const value = argv[index + 1]
      if (!value) fail("--root needs a directory")
      root = resolve(value)
      index += 1
    } else if (argument.startsWith("--root=")) {
      root = resolve(argument.slice("--root=".length))
    } else fail(`unknown argument: ${argument}`)
  }
  return { root, list }
}

function main(): void {
  const { root, list } = options(process.argv.slice(2))
  const distDir = join(root, DIST)

  if (!existsSync(join(distDir, MANIFEST))) {
    fail(
      `bundle check: no build at ${distDir} (missing ${MANIFEST}); ` +
        "run `pnpm --filter @openchat/web run build` first",
    )
  }

  const found = violations(root)
  if (list) {
    for (const { bytes, file, reason } of found) console.log(`${bytes}\t${file}\t${reason}`)
    return
  }

  if (found.length === 0) return
  for (const { bytes, file, reason } of found) {
    console.error(`${file}: ${reason}${bytes > 0 ? ` (${bytes} bytes)` : ""}`)
  }
  console.error(
    `bundle budget: ${found.length} violation(s); the contract is documented in ` +
      "docs/implementation/01-m1-m2.md",
  )
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
