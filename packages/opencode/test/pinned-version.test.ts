import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PINNED_OPENCODE_VERSION } from "../src/index"

const PACKAGE_ROOT = join(import.meta.dirname, "..")

function manifest(path: string): { version?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path, "utf8")) as {
    version?: string
    dependencies?: Record<string, string>
  }
}

describe("PINNED_OPENCODE_VERSION", () => {
  it("matches the @opencode/client dependency in the package manifest", () => {
    const pkg = manifest(join(PACKAGE_ROOT, "package.json"))
    expect(pkg.dependencies?.["@opencode/client"]).toBe(PINNED_OPENCODE_VERSION)
  })

  it("matches the installed @opencode/client package", () => {
    const installed = manifest(
      join(PACKAGE_ROOT, "node_modules", "@opencode", "client", "package.json"),
    )
    expect(installed.version).toBe(PINNED_OPENCODE_VERSION)
  })
})
