import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const SCRIPTS = join(import.meta.dirname, "..", "..", "..", "scripts")
const TEST_COUNTER = join(SCRIPTS, "count-tests.ts")
const LENGTH_COUNTER = join(SCRIPTS, "count-long-files.ts")
const created: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "openchat-counter-"))
  created.push(root)
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

function source(lines: number): string {
  return `${Array.from({ length: lines }, (_, index) => `export const v${index} = ${index}`).join("\n")}\n`
}

function run(script: string, root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" })
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("file-length counter", () => {
  it("counts a 401-line file and not a 400-line file", () => {
    const root = fixture({
      "apps/server/src/short.ts": source(400),
      "apps/server/src/long.ts": source(401),
    })
    const result = run(LENGTH_COUNTER, root)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("1\n")
    expect(run(LENGTH_COUNTER, root, "--list").stdout).toBe("401\tapps/server/src/long.ts\n")
  })

  it("skips declaration files and vendored directories", () => {
    const root = fixture({
      "apps/web/src/types.d.ts": source(401),
      "apps/web/src/types.d.mts": source(401),
      "apps/web/src/types.d.cts": source(401),
      "apps/web/node_modules/pkg/index.ts": source(401),
      "packages/opencode/dist/index.ts": source(401),
      "packages/opencode/src/ok.ts": source(400),
    })
    expect(run(LENGTH_COUNTER, root).stdout).toBe("0\n")
  })

  it("counts .mts and .cts sources", () => {
    const root = fixture({
      "apps/server/src/tool.mts": source(401),
      "apps/server/src/cli.cts": source(401),
      "scripts/build.mts": source(401),
      "scripts/release.cts": source(400),
    })
    expect(run(LENGTH_COUNTER, root, "--list").stdout).toBe(
      [
        "401\tapps/server/src/cli.cts",
        "401\tapps/server/src/tool.mts",
        "401\tscripts/build.mts",
        "",
      ].join("\n"),
    )
  })

  it("ignores ui-review as a path segment at any depth", () => {
    const root = fixture({
      "apps/web/src/features/ui-review/capture.ts": source(401),
      "apps/web/src/features/keep.ts": source(401),
    })
    expect(run(LENGTH_COUNTER, root, "--list").stdout).toBe("401\tapps/web/src/features/keep.ts\n")
  })

  it("counts only the first-party extensions", () => {
    const root = fixture({
      "apps/web/src/styles.css": source(401),
      "apps/web/src/view.tsx": source(401),
      "packages/contracts/src/index.ts": source(401),
      "packages/contracts/README.md": source(401),
    })
    expect(run(LENGTH_COUNTER, root, "--list").stdout).toBe(
      [
        "401\tapps/web/src/styles.css",
        "401\tapps/web/src/view.tsx",
        "401\tpackages/contracts/src/index.ts",
        "",
      ].join("\n"),
    )
  })
})

describe("test-count counter", () => {
  it("counts three declarations in one test file", () => {
    const root = fixture({
      "apps/web/test/three.test.tsx": [
        'import { expect, it, test } from "vitest"',
        'it("a", () => { expect(1).toBe(1) })',
        'test("b", () => { expect(2).toBe(2) })',
        "it.each([1, 2])('c %i', () => {})",
        "",
      ].join("\n"),
    })
    const result = run(TEST_COUNTER, root)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("3\n")
    expect(run(TEST_COUNTER, root, "--list").stdout).toBe("3\tapps/web/test/three.test.tsx\n")
  })

  it("ignores the screenshot harness under apps/web/screenshots", () => {
    const root = fixture({
      "apps/web/screenshots/harness.test.ts": 'it("not a functional test", () => {})\n',
      "apps/web/test/real.test.ts": 'it("counted", () => {})\n',
    })
    expect(run(TEST_COUNTER, root).stdout).toBe("1\n")
    expect(run(TEST_COUNTER, root, "--list").stdout).toBe("1\tapps/web/test/real.test.ts\n")
  })

  it("counts Playwright specs under apps/web/e2e", () => {
    const root = fixture({
      "apps/web/e2e/auth.spec.ts": 'test("login", async () => {})\n',
      "apps/web/e2e/stop.spec.tsx": 'test.skip("stop", async () => {})\n',
    })
    const result = run(TEST_COUNTER, root)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("2\n")
    expect(run(TEST_COUNTER, root, "--list").stdout).toBe(
      ["1\tapps/web/e2e/auth.spec.ts", "1\tapps/web/e2e/stop.spec.tsx", ""].join("\n"),
    )
  })

  it("counts Playwright .spec.mts files under apps/web/e2e", () => {
    const root = fixture({
      "apps/web/e2e/render.spec.mts": 'test("render", async () => {})\n',
      "apps/web/e2e/auth.spec.cts": 'test("auth", async () => {})\n',
      "apps/web/foo.spec.mts": 'test("stray spec", async () => {})\n',
    })
    const result = run(TEST_COUNTER, root)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("2\n")
    expect(run(TEST_COUNTER, root, "--list").stdout).toBe(
      ["1\tapps/web/e2e/auth.spec.cts", "1\tapps/web/e2e/render.spec.mts", ""].join("\n"),
    )
  })

  it("ignores *.spec.ts outside apps/web/e2e", () => {
    const root = fixture({
      "apps/web/screenshots/ui-screenshots.spec.ts": 'test("screenshot", async () => {})\n',
      "apps/web/foo.spec.ts": 'test("stray spec", async () => {})\n',
      "apps/web/test/real.test.ts": 'it("counted", () => {})\n',
    })
    const result = run(TEST_COUNTER, root)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("1\n")
    expect(run(TEST_COUNTER, root, "--list").stdout).toBe("1\tapps/web/test/real.test.ts\n")
  })

  it("does not count helper files or non-test sources", () => {
    const root = fixture({
      "apps/server/test/helpers.ts": 'it("not a test file", () => {})\n',
      "apps/server/src/app.ts": 'it("not a test file", () => {})\n',
      "packages/opencode/test/queue.test.ts": 'it.skip("skipped", () => {})\ntest.todo("later")\n',
    })
    expect(run(TEST_COUNTER, root).stdout).toBe("2\n")
  })
})
