import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  commit,
  fakeBin,
  fixture,
  git,
  initRepo,
  logLines,
  runRelease,
  workspace,
} from "./release-fixture"

afterEach(cleanup)

function repo(): string {
  const root = fixture(workspace())
  initRepo(root)
  commit(root, "chore: seed the workspace")
  return root
}

interface Fakes {
  env: Record<string, string>
  log: string
}

function fakes(...names: string[]): Fakes {
  const binRoot = fixture({})
  const bin = fakeBin(binRoot, names[0] ?? "pnpm")
  for (const name of names.slice(1)) {
    const path = join(bin, name)
    writeFileSync(path, readFileSync(join(bin, names[0] ?? "pnpm")))
    chmodSync(path, 0o755)
  }
  const log = join(bin, "calls.log")
  return {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, LOG: log },
    log,
  }
}

function replaceVersion(root: string, path: string, version: string): void {
  const file = join(root, path)
  writeFileSync(file, readFileSync(file, "utf8").replace(/"version": "[^"]*"/, `"version": "${version}"`))
}

// Every case spawns git and a Node process; under a parallel full-suite run
// a single case reached 9.5 s and hit the 5 s default. The work is bounded
// by the fixture, not by the clock, so the limit moves instead of the test.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

describe("release check", () => {
  it("passes a clean, agreeing workspace with a changelog section", () => {
    const root = repo()
    const result = runRelease(root, ["check", "--skip-gates", "--skip-verify"])
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("release check: ok for 1.2.3")
  })

  it("fails when a package disagrees with VERSION", () => {
    const root = repo()
    replaceVersion(root, "packages/contracts/package.json", "9.9.9")
    commit(root, "chore: break the version agreement")
    const result = runRelease(root, ["check", "--skip-gates", "--skip-verify"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("packages/contracts/package.json")
    expect(result.stderr).toContain("9.9.9")
  })

  it("fails when the changelog lacks the version", () => {
    const root = repo()
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n")
    commit(root, "docs: drop the release section")
    const result = runRelease(root, ["check", "--skip-gates", "--skip-verify"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CHANGELOG.md has no "## [1.2.3]" section')
  })

  it("fails on a dirty tree before running any gate", () => {
    const root = repo()
    const { env, log } = fakes("pnpm", "ratchet")
    writeFileSync(join(root, "uncommitted.txt"), "dirty\n")
    const result = runRelease(root, ["check", "--skip-verify"], env)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("dirty")
    expect(logLines(log)).toEqual([])
  })

  it("runs gates:fast and propagates its failure", () => {
    const root = repo()
    const { env, log } = fakes("pnpm", "ratchet")
    const passed = runRelease(root, ["check", "--skip-verify"], env)
    expect(passed.status).toBe(0)
    expect(logLines(log)).toContain("run gates:fast")

    const failed = runRelease(root, ["check", "--skip-verify"], { ...env, CODE: "1" })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("gates failed")
  })

  it("runs ratchet verify only when the config declares it", () => {
    const withVerify = repo()
    writeFileSync(
      join(withVerify, "ratchet.config.jsonc"),
      '// gates\n[\n  { "name": "x", "verify": { "checks": [] } }\n]\n',
    )
    commit(withVerify, "chore: configure verify")
    const first = fakes("pnpm", "ratchet")
    expect(runRelease(withVerify, ["check", "--skip-gates"], first.env).status).toBe(0)
    expect(logLines(first.log)).toEqual(["verify"])

    const withoutVerify = repo()
    const second = fakes("pnpm", "ratchet")
    expect(runRelease(withoutVerify, ["check", "--skip-gates"], second.env).status).toBe(0)
    expect(logLines(second.log)).toEqual([])
  })

  it("adds Playwright only with --with-e2e", () => {
    const root = repo()
    const { env, log } = fakes("pnpm", "ratchet")
    expect(runRelease(root, ["check", "--skip-gates", "--skip-verify"], env).status).toBe(0)
    expect(logLines(log)).toEqual([])

    expect(
      runRelease(root, ["check", "--skip-gates", "--skip-verify", "--with-e2e"], env).status,
    ).toBe(0)
    expect(logLines(log)).toEqual(["run test:e2e"])
  })

  it("checks the changelog against the requested tag", () => {
    const root = repo()
    const mismatch = runRelease(root, ["check", "--skip-gates", "--skip-verify", "--tag", "v2.0.0"])
    expect(mismatch.status).toBe(1)
    expect(mismatch.stderr).toContain("tag v2.0.0 says 2.0.0")

    git(root, "tag", "v1.2.3")
    const matching = runRelease(root, ["check", "--skip-gates", "--skip-verify"])
    expect(matching.status).toBe(0)
  })
})
