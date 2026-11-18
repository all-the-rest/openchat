import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

interface PackageRule {
  description?: string
  matchManagers?: string[]
  matchPackageNames?: string[]
  matchUpdateTypes?: string[]
  groupName?: string
  automerge?: boolean
  platformAutomerge?: boolean
  addLabels?: string[]
}

interface RenovateConfig {
  enabledManagers?: string[]
  packageRules?: PackageRule[]
}

const ROOT = join(import.meta.dirname, "..", "..", "..")

const config = JSON.parse(readFileSync(join(ROOT, "renovate.json"), "utf8")) as RenovateConfig

function rulesFor(packageName: string, updateType: "minor" | "major"): PackageRule[] {
  return (config.packageRules ?? []).filter(
    (rule) =>
      rule.matchManagers?.includes("npm") === true &&
      rule.matchPackageNames?.includes(packageName) === true &&
      rule.matchUpdateTypes?.includes(updateType) === true,
  )
}

describe("renovate.json", () => {
  it("is valid JSON with only the npm and GitHub Actions managers", () => {
    expect(config.enabledManagers).toEqual(["npm", "github-actions"])
  })

  it("auto-merges @opencode/client minor and patch updates after CI", () => {
    const [rule] = rulesFor("@opencode/client", "minor")
    expect(rule).toBeDefined()
    expect(rule?.groupName).toBe("@opencode/client")
    expect(rule?.automerge).toBe(true)
    expect(rule?.platformAutomerge).toBe(true)
    expect(rule?.matchUpdateTypes).toEqual(expect.arrayContaining(["minor", "patch"]))
  })

  it("keeps @opencode/client major updates manual", () => {
    const [rule] = rulesFor("@opencode/client", "major")
    expect(rule).toBeDefined()
    expect(rule?.automerge).toBe(false)
    expect(rule?.addLabels).toContain("major")
  })

  it("groups pnpm minor and patch updates behind auto-merge", () => {
    const rule = (config.packageRules ?? []).find(
      (entry) =>
        entry.matchManagers?.includes("npm") === true &&
        entry.matchPackageNames === undefined &&
        entry.matchUpdateTypes?.includes("minor") === true &&
        entry.matchUpdateTypes?.includes("patch") === true,
    )
    expect(rule).toBeDefined()
    expect(rule?.automerge).toBe(true)
    expect(rule?.platformAutomerge).toBe(true)
  })

  it("groups GitHub Actions updates and keeps majors manual", () => {
    const minor = (config.packageRules ?? []).find(
      (entry) =>
        entry.matchManagers?.includes("github-actions") === true &&
        entry.matchUpdateTypes?.includes("minor") === true &&
        entry.matchUpdateTypes?.includes("patch") === true,
    )
    expect(minor).toBeDefined()
    expect(minor?.automerge).toBe(true)
    expect(minor?.platformAutomerge).toBe(true)

    const major = (config.packageRules ?? []).find(
      (entry) =>
        entry.matchManagers?.includes("github-actions") === true &&
        entry.matchUpdateTypes?.includes("major") === true,
    )
    expect(major).toBeDefined()
    expect(major?.automerge).toBe(false)
    expect(major?.addLabels).toContain("major")
  })

  it("has no latest-tag or image-update rules", () => {
    const text = JSON.stringify(config)
    expect(text).not.toContain("latest")
    expect(config.enabledManagers).not.toContain("dockerfile")
    expect(config.enabledManagers).not.toContain("docker-compose")
  })
})
