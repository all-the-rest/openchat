import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  cleanup,
  commit,
  fixture,
  git,
  initRepo,
  PACKAGES,
  readJson,
  runRelease,
  workspace,
} from "./release-fixture"

afterEach(cleanup)

function repo(version = "1.2.3"): string {
  const root = fixture(workspace(version))
  initRepo(root)
  commit(root, "chore: seed the workspace")
  return root
}

describe("version bump", () => {
  it("walks the semver table: patch, minor, major", () => {
    const root = repo()
    expect(runRelease(root, ["bump", "--patch", "--allow-dirty"]).status).toBe(0)
    expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("1.2.4")
    expect(runRelease(root, ["bump", "--minor", "--allow-dirty"]).status).toBe(0)
    expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("1.3.0")
    expect(runRelease(root, ["bump", "--major", "--allow-dirty"]).status).toBe(0)
    expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("2.0.0")
  })

  it("sets an explicit version and keeps every package in agreement", () => {
    const root = repo()
    const result = runRelease(root, ["bump", "--set", "2.0.0", "--allow-dirty"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("1.2.3 -> 2.0.0")

    expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("2.0.0")
    for (const path of PACKAGES) {
      expect(readJson(join(root, path, "package.json")).version).toBe("2.0.0")
    }
    expect(readFileSync(join(root, "apps/server/src/app.ts"), "utf8")).toContain(
      'SERVER_VERSION = "2.0.0"',
    )
    expect(readJson(join(root, "apps/web/package.json")).version).toBeUndefined()
    const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
    expect(lockfile).toContain("apps/server:\n    version: 2.0.0")
    expect(runRelease(root, ["version"]).stdout.trim()).toBe("2.0.0")
  })

  it("adds a version to a manifest that has none", () => {
    const root = repo()
    const path = join(root, "packages/contracts/package.json")
    writeFileSync(path, '{\n  "name": "@openchat/contracts",\n  "private": true\n}\n')
    commit(root, "chore: drop the contracts version")
    expect(runRelease(root, ["bump", "--patch"]).status).toBe(0)
    expect(readJson(path).version).toBe("1.2.4")
  })

  it("refuses a dirty tree unless --allow-dirty is passed", () => {
    const root = repo()
    writeFileSync(join(root, "scratch.txt"), "uncommitted\n")
    const refused = runRelease(root, ["bump", "--patch"])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("dirty")
    expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("1.2.3")

    const allowed = runRelease(root, ["bump", "--patch", "--allow-dirty"])
    expect(allowed.status).toBe(0)
    expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("1.2.4")
  })

  it("writes nothing on --dry-run and prints every file", () => {
    const root = repo()
    const files = [
      "VERSION",
      ...PACKAGES.map((path) => `${path}/package.json`),
      "apps/server/src/app.ts",
      "pnpm-lock.yaml",
    ]
    const before = new Map(files.map((path) => [path, readFileSync(join(root, path), "utf8")]))
    const result = runRelease(root, ["bump", "--set", "2.0.0", "--dry-run", "--allow-dirty"])
    expect(result.status).toBe(0)
    for (const path of ["VERSION", "apps/server/package.json", "apps/server/src/app.ts"]) {
      expect(result.stdout).toContain(`would write ${path}`)
    }
    expect(result.stdout).toContain("would bump: 1.2.3 -> 2.0.0")
    for (const [path, contents] of before) {
      expect(readFileSync(join(root, path), "utf8")).toBe(contents)
    }
    expect(git(root, "status", "--porcelain")).toBe("")
  })

  it("rejects no selector, two selectors, a malformed version and a no-op", () => {
    const root = repo()
    expect(runRelease(root, ["bump"]).status).toBe(2)
    expect(runRelease(root, ["bump", "--major", "--minor"]).status).toBe(2)
    expect(runRelease(root, ["bump", "--set", "2.0"]).status).toBe(2)
    expect(runRelease(root, ["bump", "--set", "1.2.3"]).status).toBe(2)
    expect(runRelease(root, ["bump", "--patch", "--bogus"]).status).toBe(2)
  })

  it("accepts the separator that pnpm forwards", () => {
    const root = repo()
    const result = runRelease(root, ["bump", "--", "--patch", "--dry-run", "--allow-dirty"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("would bump: 1.2.3 -> 1.2.4")
    expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("1.2.3")
  })

  it("refuses to run outside a git repository", () => {
    const root = fixture(workspace())
    const result = runRelease(root, ["bump", "--patch", "--allow-dirty"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("not a git repository")
  })
})
