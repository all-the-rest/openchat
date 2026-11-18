import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DIST,
  EAGER_ROUTES,
  LAZY_ROUTES,
  LIMIT,
  MANIFEST,
  resolveKey,
  type Manifest,
} from "../../../scripts/check-bundle"

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "check-bundle.ts")
const created: string[] = []

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  manifest: Manifest
  sizes: Record<string, number>
}

/**
 * A build that satisfies the contract: an eager entry, one lazy chunk per
 * route, and Mermaid's lazy graph with an oversized ELK layout.
 */
function validBuild(): Fixture {
  const manifest: Manifest = {
    "index.html": {
      file: "assets/index-entry.js",
      isEntry: true,
      imports: ["_icons.js"],
      dynamicImports: [...LAZY_ROUTES],
      assets: ["assets/local-worker-fixture.js"],
    },
    "_icons.js": { file: "assets/icons.js", imports: ["_rolldown-runtime.js"] },
    "_rolldown-runtime.js": { file: "assets/rolldown-runtime.js" },
    "../../node_modules/.pnpm/mermaid@12.3.0/node_modules/mermaid/dist/mermaid.core.mjs": {
      file: "assets/mermaid.core.js",
      isDynamicEntry: true,
      imports: ["_parser.js", "index.html"],
      dynamicImports: ["elk.mjs"],
    },
    "_parser.js": { file: "assets/chunk-parser.js", imports: ["_rolldown-runtime.js"] },
    "elk.mjs": { file: "assets/elk.js", imports: ["_parser.js"] },
  }

  const sizes: Record<string, number> = {}
  for (const chunk of Object.values(manifest)) sizes[chunk.file] = 1_000
  sizes["assets/local-worker-fixture.js"] = 1_000
  sizes["assets/elk.js"] = LIMIT + 998_000

  for (const route of LAZY_ROUTES) {
    const file = `assets/${route.split("/").pop()?.replace(/\.tsx$/, "")}.js`
    manifest[route] = { file, isDynamicEntry: true, imports: ["index.html"] }
    sizes[file] = 1_000
  }

  return { manifest, sizes }
}

function build(build: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "openchat-bundle-"))
  created.push(root)
  const dist = join(root, DIST)
  mkdirSync(join(dist, ".vite"), { recursive: true })
  writeFileSync(join(dist, MANIFEST), JSON.stringify(build.manifest))
  for (const [file, bytes] of Object.entries(build.sizes)) {
    mkdirSync(join(dist, file, ".."), { recursive: true })
    writeFileSync(join(dist, file), "x".repeat(bytes))
  }
  return root
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" })
}

describe("bundle budget", () => {
  it("accepts the split build and exempts Mermaid's lazy graph", () => {
    const result = run(build(validBuild()))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })

  it("counts a chunk over 500 kB outside the Mermaid graph", () => {
    const fixture = validBuild()
    fixture.sizes["assets/ChatPage.js"] = LIMIT + 1
    const root = build(fixture)

    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      `assets/ChatPage.js: over ${LIMIT} bytes (${LIMIT + 1} bytes)`,
    )
    expect(result.stderr).toContain("bundle budget: 1 violation(s)")
    expect(run(root, "--list").stdout).toBe(
      `${LIMIT + 1}\tassets/ChatPage.js\tover ${LIMIT} bytes\n`,
    )
  })

  it("fails when the entry chunk itself exceeds the budget", () => {
    const fixture = validBuild()
    fixture.sizes["assets/index-entry.js"] = LIMIT + 1
    const result = run(build(fixture), "--list")
    expect(result.stdout).toBe(`${LIMIT + 1}\tassets/index-entry.js\tover ${LIMIT} bytes\n`)
  })

  it("counts a route that is no longer a dynamic import of the entry", () => {
    const fixture = validBuild()
    fixture.manifest["index.html"] = {
      file: "assets/index-entry.js",
      isEntry: true,
      imports: ["_icons.js"],
      dynamicImports: LAZY_ROUTES.filter((route) => route !== "src/pages/ChatPage.tsx"),
      assets: ["assets/local-worker-fixture.js"],
    }
    fixture.manifest["src/pages/ChatPage.tsx"] = {
      file: "assets/ChatPage.js",
      imports: ["index.html"],
    }

    expect(run(build(fixture), "--list").stdout).toBe(
      `0\tsrc/pages/ChatPage.tsx\troute must be a dynamic import of the entry (lazy chunk)\n`,
    )
  })

  it("counts a first-paint route that became lazy", () => {
    const fixture = validBuild()
    const [login, ...rest] = EAGER_ROUTES
    expect(login).toBeDefined()
    expect(rest).toEqual(["src/pages/LandingPage.tsx"])
    fixture.manifest[login as string] = {
      file: "assets/LoginPage.js",
      isDynamicEntry: true,
      imports: ["index.html"],
    }

    expect(run(build(fixture), "--list").stdout).toBe(
      `0\t${login}\tfirst-paint route must stay in the eager entry chunk\n`,
    )
  })

  it("does not exempt the entry through the Mermaid graph", () => {
    const fixture = validBuild()
    fixture.sizes["assets/index-entry.js"] = LIMIT + 1
    expect(run(build(fixture)).status).toBe(1)
  })

  it("fails loudly when no build exists", () => {
    const root = mkdtempSync(join(tmpdir(), "openchat-bundle-"))
    created.push(root)
    const result = run(root)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("no build at")
    expect(result.stdout).toBe("")
  })

  it("requires the speech worker as a lazy asset", () => {
    const fixture = validBuild()
    delete fixture.manifest["index.html"]?.assets
    expect(run(build(fixture), "--list").stdout).toBe(
      "0\tassets/local-worker-*.js\tspeech worker must be a lazy asset of the entry\n",
    )
  })

  it("keeps the ONNX runtime out of the entry chunk", () => {
    const fixture = validBuild()
    const root = build(fixture)
    const entry = join(root, DIST, fixture.manifest["index.html"]?.file ?? "")
    writeFileSync(entry, "onnxruntime-web must not be here")
    expect(run(root, "--list").stdout).toBe(
      "0\tassets/index-entry.js\tmodel runtime must not enter the entry chunk\n",
    )
  })

  it("resolves manifest references by key", () => {
    const fixture = validBuild()
    expect(resolveKey(fixture.manifest, "index.html")).toBe("index.html")
    expect(resolveKey(fixture.manifest, "assets/elk.js")).toBe("elk.mjs")
    expect(resolveKey(fixture.manifest, "missing.js")).toBeUndefined()
  })
})
