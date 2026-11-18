import { readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Workspace boundary invariants.
 *
 * Apps are deployment units, not libraries: `apps/artifact-host` once imported
 * the BFF's signer and the tool package imported the host's bridge, which made
 * both images depend on another app's source tree. The shared contract now
 * lives in `@openchat/contracts`; this test reads the real imports so the edge
 * cannot come back unnoticed.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const APPS = join(ROOT, "apps")
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/

const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
]

interface App {
  dir: string
  name: string
}

/** Import specifiers in source order, including dynamic and side-effect forms. */
function importedSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) found.push(specifier)
    }
  }
  return found
}

/** `@scope/name/subpath` → `@scope/name`. */
function packageOf(specifier: string): string | undefined {
  return /^(@[^/]+\/[^/]+)/.exec(specifier)?.[1]
}

function manifest(appDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(APPS, appDir, "package.json"), "utf8"))
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${appDir}: bad manifest`)
  return parsed as Record<string, unknown>
}

function apps(): App[] {
  return readdirSync(APPS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const name = manifest(entry.name).name
      if (typeof name !== "string") throw new Error(`${entry.name}: manifest has no name`)
      return { dir: entry.name, name }
    })
}

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (SOURCE_FILE.test(entry.name)) files.push(path)
  }
  return files
}

describe("app boundaries", () => {
  const APP_LIST = apps()
  const APP_BY_NAME = new Map(APP_LIST.map((app) => [app.name, app.dir]))

  it("sees every app instead of passing on an empty scan", () => {
    expect(APP_LIST.map((app) => app.dir).sort()).toEqual([
      "artifact-host",
      "code-host",
      "server",
      "web",
    ])
    expect(walk(APPS).length).toBeGreaterThan(20)
  })

  it("detects an app→app edge in source text", () => {
    const foreignApp = ["@openchat", "server"].join("/")
    const source = `import { ArtifactSigner } from "${foreignApp}/artifacts-sign"`
    expect(importedSpecifiers(source)).toEqual([`${foreignApp}/artifacts-sign`])
    expect(packageOf(`${foreignApp}/artifacts-sign`)).toBe(foreignApp)
  })

  it("never imports another app from apps/**", () => {
    const violations: string[] = []
    for (const app of APP_LIST) {
      for (const path of walk(join(APPS, app.dir))) {
        const source = readFileSync(path, "utf8")
        for (const specifier of importedSpecifiers(source)) {
          const target = packageOf(specifier)
          if (target === undefined || !APP_BY_NAME.has(target)) continue
          const targetDir = APP_BY_NAME.get(target)
          if (targetDir === app.dir) continue
          violations.push(`${relative(ROOT, path)}: ${app.name} imports ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("never declares another app as a dependency", () => {
    const violations: string[] = []
    for (const app of APP_LIST) {
      const fields = ["dependencies", "devDependencies"] as const
      for (const field of fields) {
        const deps = manifest(app.dir)[field]
        if (typeof deps !== "object" || deps === null) continue
        for (const name of Object.keys(deps)) {
          if (name === app.name || !APP_BY_NAME.has(name)) continue
          violations.push(`${app.dir}/package.json: ${field}.${name}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("keeps the node:crypto signer and shim off the browser entry point", () => {
    // The root index is what the web bundle imports. Signing needs
    // `node:crypto` and the shim text is tool-only, so both stay subpath
    // exports and are never re-exported by a barrel.
    for (const barrel of [
      "packages/contracts/src/index.ts",
      "packages/contracts/src/artifacts/index.ts",
    ]) {
      const source = readFileSync(join(ROOT, barrel), "utf8")
      for (const forbidden of ["./artifacts/sign", "./artifacts/bridge", "./sign", "./bridge"]) {
        expect(source, `${barrel} must not re-export ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})
