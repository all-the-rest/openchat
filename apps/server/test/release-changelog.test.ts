import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  cleanup,
  commit,
  fixture,
  git,
  initRepo,
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

function seedHistory(root: string): void {
  commit(root, "feat(code): serve the surface\n\nRefs #11", {
    "apps/server/src/code.ts": "export const code = 1\n",
  })
  commit(root, "fix(server): key the throttle\n\nCloses #31", {
    "apps/server/src/throttle.ts": "export const throttle = 1\n",
  })
  commit(root, "docs(env): document variables\n\nRefs #11", {
    "docs/env.md": "variables\n",
  })
  commit(
    root,
    "feat(deploy)!: drop the old protocol\n\nBREAKING CHANGE: old clients are rejected\n\nCloses #40",
    { "deploy/note.md": "breaking\n" },
  )
  commit(root, "perf(search): trim the index\n\nRefs #12 #13", {
    "apps/server/src/search.ts": "export const search = 1\n",
  })
  commit(root, "chore: tidy the scripts", { "scripts/note.txt": "tidy\n" })
  commit(root, "test: ignore prose\n\nIssue #20 is discussed, not referenced.", {
    "apps/server/test/note.test.ts": "// prose\n",
  })

  git(root, "checkout", "-q", "-b", "topic")
  commit(root, "feat(topic): merged feature", { "topic.txt": "topic\n" })
  git(root, "checkout", "-q", "main")
  git(root, "merge", "--no-ff", "-q", "-m", "merge: topic", "topic")
}

describe("changelog", () => {
  it("groups by issue reference and conventional type, deterministically", () => {
    const root = repo()
    seedHistory(root)
    const result = runRelease(root, [
      "changelog",
      "--version",
      "2.0.0",
      "--date",
      "2026-11-18",
      "--dry-run",
    ])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    const output = result.stdout

    expect(output).toContain("## [2.0.0] - 2026-11-18")
    expect(output).toContain("### Added")
    expect(output).toContain("- serve the surface (#11)")
    expect(output).toContain("- **Breaking:** drop the old protocol (#40)")
    expect(output).toContain("### Fixed")
    expect(output).toContain("- key the throttle (#31)")
    expect(output).toContain("### Documentation")
    expect(output).toContain("- document variables (#11)")
    expect(output).toContain("### Changed")
    expect(output).toContain("- trim the index (#12, #13)")
    expect(output).toContain("- tidy the scripts")
    // The branch commit is a change; the merge commit that carried it is not,
    // and prose that names an issue without a Refs/Closes keyword is not a
    // reference.
    expect(output).toContain("- merged feature")
    expect(output).not.toContain("merge: topic")
    expect(output).not.toContain("#20")
    // The prior release stays below the new section.
    expect(output.indexOf("## [2.0.0]")).toBeLessThan(output.indexOf("## [1.2.3]"))
  })

  it("replaces a section instead of appending a duplicate", () => {
    const root = repo()
    seedHistory(root)
    expect(
      runRelease(root, ["changelog", "--version", "2.0.0", "--date", "2026-11-18"]).status,
    ).toBe(0)
    expect(
      runRelease(root, ["changelog", "--version", "2.0.0", "--date", "2026-11-19"]).status,
    ).toBe(0)
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    expect(text.match(/## \[2\.0\.0\]/g)).toHaveLength(1)
    expect(text).toContain("## [2.0.0] - 2026-11-19")
  })

  it("writes nothing and reports an empty range", () => {
    const root = repo()
    const before = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    const result = runRelease(root, ["changelog", "--version", "2.0.0", "--from", "HEAD"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("no commits since")
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(before)
  })

  it("defaults to the newest commit's committer date", () => {
    const root = repo()
    seedHistory(root)
    const expected = git(root, "log", "-1", "--format=%cs").trim()
    const result = runRelease(
      root,
      ["changelog", "--version", "2.0.0", "--dry-run"],
      { SOURCE_DATE_EPOCH: "" },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`## [2.0.0] - ${expected}`)
  })

  it("produces the same bytes for the same history", () => {
    const root = repo()
    seedHistory(root)
    const args = ["changelog", "--version", "2.0.0", "--date", "2026-11-18", "--dry-run"]
    const first = runRelease(root, args)
    const second = runRelease(root, args)
    expect(first.status).toBe(0)
    expect(second.stdout).toBe(first.stdout)
  })

  it("takes the date from SOURCE_DATE_EPOCH in UTC", () => {
    const root = repo()
    seedHistory(root)
    const epoch = String(Date.UTC(2026, 10, 18) / 1000)
    const result = runRelease(
      root,
      ["changelog", "--version", "2.0.0", "--dry-run"],
      { SOURCE_DATE_EPOCH: epoch },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("## [2.0.0] - 2026-11-18")
  })

  it("rejects an invalid date and version", () => {
    const root = repo()
    expect(runRelease(root, ["changelog", "--version", "2.0.0", "--date", "18.11.2026"]).status).toBe(2)
    expect(runRelease(root, ["changelog", "--version", "2", "--date", "2026-11-18"]).status).toBe(2)
  })
})
