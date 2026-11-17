/**
 * Ratchet counter: first-party code files over 400 lines (ceiling).
 *
 * Walks first-party code only — `apps/**\/*.{ts,tsx,mts,cts,css}`,
 * `packages/**\/*.{ts,tsx,mts,cts}`, `scripts/**\/*.{ts,mts,cts}` — and counts
 * files whose line count is greater than 400. Generated output, vendored trees,
 * test reports and declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are skipped.
 * The skipped directory names (`node_modules`, `dist`, `.vite`, `coverage`,
 * `test-results`, `ui-review`) match as a path segment at any depth, not only
 * at the top level. `apps/web/screenshots/**` stays in scope because it is
 * first-party code even though it is not a functional test.
 *
 * Line counting follows `wc -l`: a trailing newline does not add a line.
 *
 * Default mode prints only the integer. `--list` prints one
 * `<lines>\t<path>` line per over-limit file for humans. `--root <dir>` points
 * the walk at another tree; the tests use it with a temporary fixture.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const SKIP = new Set([
  "node_modules",
  "dist",
  ".vite",
  "coverage",
  "test-results",
  "ui-review",
])
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/

/** Which extensions count as first-party code per top-level scope. */
const SCOPES: Record<string, RegExp> = {
  apps: /\.(?:tsx?|mts|cts|css)$/,
  packages: /\.(?:tsx?|mts|cts)$/,
  scripts: /\.(?:ts|mts|cts)$/,
}

export const LIMIT = 400

export function lineCount(text: string): number {
  if (text.length === 0) return 0
  const lines = text.split("\n")
  return text.endsWith("\n") ? lines.length - 1 : lines.length
}

function skipped(rel: string): boolean {
  return rel.split("/").some((segment) => SKIP.has(segment))
}

function walk(dir: string, scope: RegExp, relDir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`
    if (skipped(rel)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, scope, rel, out)
      continue
    }
    if (!scope.test(entry.name) || DECLARATION_FILE.test(entry.name)) continue
    out.push(path)
  }
}

/** First-party code files under `root`, as absolute paths, sorted. */
export function codeFiles(root: string): string[] {
  const files: string[] = []
  for (const [top, scope] of Object.entries(SCOPES)) {
    const start = join(root, top)
    if (existsSync(start)) walk(start, scope, top, files)
  }
  return files.sort()
}

/** Files over the 400-line ceiling, sorted by path. */
export function longFiles(root: string): Array<{ file: string; lines: number }> {
  return codeFiles(root)
    .map((path) => ({
      file: relative(root, path).split("\\").join("/"),
      lines: lineCount(readFileSync(path, "utf8")),
    }))
    .filter((entry) => entry.lines > LIMIT)
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
  const over = longFiles(root)
  if (list) {
    for (const { file, lines } of over) console.log(`${lines}\t${file}`)
    return
  }
  console.log(over.length)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
