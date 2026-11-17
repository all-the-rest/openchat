/**
 * Ratchet counter: declared functional test cases (floor).
 *
 * Counts `it(...)`/`test(...)` declarations (including the `each`, `skip`,
 * `only`, `todo` and `fails` modifiers) in two places:
 *
 * - `*.test.{ts,tsx,mts,cts}` under `apps/**` and `packages/**`;
 * - `*.spec.{ts,tsx,mts,cts}` under `apps/web/e2e/**` only, the functional
 *   Playwright suite.
 *
 * `apps/web/screenshots/**` is a screenshot harness, not a functional test,
 * and is skipped; `*.spec.*` files elsewhere (including the harness) are not
 * counted.
 *
 * The floor means the suite may grow but never shrink silently.
 *
 * Default mode prints only the integer. `--list` prints one `<count>\t<path>`
 * line per file for humans. `--root <dir>` points the walk at another tree;
 * the tests use it with a temporary fixture.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const SKIP = new Set(["node_modules", "dist", ".vite"])
const EXCLUDED = "apps/web/screenshots"
const E2E = "apps/web/e2e"
const UNIT_TEST_FILE = /\.test\.(?:tsx?|mts|cts)$/
const SPEC_FILE = /\.spec\.(?:tsx?|mts|cts)$/

export const DECLARATION_RE =
  /^\s*(?:it|test)(?:\.(?:each|skip|only|todo|fails))?\s*\(/gm

export function countDeclarations(text: string): number {
  return text.match(DECLARATION_RE)?.length ?? 0
}

/** Whether a root-relative path is a counted test file. */
export function isTestFile(rel: string): boolean {
  if (rel === EXCLUDED || rel.startsWith(`${EXCLUDED}/`)) return false
  if (UNIT_TEST_FILE.test(rel)) return true
  return rel.startsWith(`${E2E}/`) && SPEC_FILE.test(rel)
}

function walk(dir: string, relDir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const rel = `${relDir}/${entry.name}`
    if (rel === EXCLUDED || rel.startsWith(`${EXCLUDED}/`)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, rel, out)
    else if (isTestFile(rel)) out.push(path)
  }
}

/** Test files under `root`, as absolute paths, sorted. */
export function testFiles(root: string): string[] {
  const files: string[] = []
  for (const top of ["apps", "packages"]) {
    const start = join(root, top)
    if (existsSync(start)) walk(start, top, files)
  }
  return files.sort()
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
  const counted = testFiles(root).map((file) => ({
    file: relative(root, file).split("\\").join("/"),
    count: countDeclarations(readFileSync(file, "utf8")),
  }))

  if (list) {
    for (const { file, count } of counted) console.log(`${count}\t${file}`)
    return
  }
  console.log(counted.reduce((total, entry) => total + entry.count, 0))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
