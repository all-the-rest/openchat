import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..")
const WORKFLOW = join(ROOT, ".github", "workflows", "ci-opencode-image.yml")
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml")
const DOCKERFILE = join(ROOT, "deploy", "Dockerfile.opencode")

const REQUIRED_PATHS = [
  "deploy/Dockerfile.opencode",
  "deploy/python-smoke.py",
  "packages/python-env/**",
  "packages/python-tool/**",
  ".github/workflows/ci-opencode-image.yml",
]

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8")
}

function releaseWorkflow(): string {
  return readFileSync(RELEASE_WORKFLOW, "utf8")
}

function dockerfile(): string {
  return readFileSync(DOCKERFILE, "utf8")
}

/**
 * Trimmed lines of the YAML section whose header is `<indent spaces><key>:`.
 * Stops at a sibling key of the same indent (or a dedent to a parent).
 */
function section(text: string, key: string, indent: number): string[] {
  const lines = text.split("\n")
  const prefix = " ".repeat(indent)
  const start = lines.findIndex((line) => line === `${prefix}${key}:`)
  expect(start, `${key} section`).toBeGreaterThan(-1)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) continue
    const current = line.length - line.trimStart().length
    if (current < indent) break
    if (current === indent && line.trim().endsWith(":")) break
    out.push(line)
  }
  return out
}

/** Trimmed lines of the YAML step containing `marker`, indentation removed. */
function stepBlock(text: string, marker: string): string[] {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.includes(marker))
  expect(start, `step ${marker}`).toBeGreaterThan(-1)
  const indent = lines[start]!.length - lines[start]!.trimStart().length
  const out = [lines[start]!.trim()]
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) continue
    if (line.length - line.trimStart().length <= indent) break
    out.push(line.trim())
  }
  return out
}

describe("CI opencode image gate", () => {
  it("runs on toolchain-path PRs and main pushes, never on tags", () => {
    const onLines = section(workflow(), "on", 0)
    const on = onLines.join("\n")
    const triggers = onLines
      .filter((line) => /^ {2}[a-z][a-z_-]*:$/.test(line))
      .map((line) => line.trim().replace(":", ""))
    expect(triggers).toEqual(["pull_request", "push", "schedule"])

    for (const trigger of ["pull_request", "push"]) {
      const block = section(on, trigger, 2).join("\n")
      for (const path of REQUIRED_PATHS) {
        expect(block, `${trigger} must filter ${path}`).toContain(`- ${path}`)
      }
    }

    const push = section(on, "push", 2).join("\n")
    expect(push).toContain("branches: [main]")
    expect(push).not.toMatch(/tags:/)
    // No tag trigger anywhere in `on:`: the release owns that path.
    expect(on).not.toMatch(/^\s+tags:/m)
  })

  it("has a weekly schedule canary for upstream drift", () => {
    const on = section(workflow(), "on", 0).join("\n")
    const schedule = section(on, "schedule", 2).join("\n")
    const crons = [...schedule.matchAll(/cron:\s*["']?([^"'\n]+)["']?/g)].map((match) =>
      (match[1] ?? "").trim(),
    )
    expect(crons).toHaveLength(1)
    const fields = crons[0]!.split(/\s+/)
    expect(fields).toHaveLength(5)
    // day-of-week pinned rather than `*` → a weekly cadence, not per-minute.
    expect(fields[4]).not.toBe("*")
  })

  it("bypasses the cache on the scheduled canary so the smoke re-executes", () => {
    const build = stepBlock(workflow(), "uses: docker/build-push-action@v6").join("\n")
    // A cache hit would restore the `--network=none` smoke layer too, making an
    // unchanged weekly run useless for detecting upstream drift. The bypass
    // must be tied to the schedule event, not hardcoded for every trigger.
    expect(build).toContain("no-cache: ${{ github.event_name == 'schedule' }}")
    expect(build).not.toMatch(/^\s*no-cache:\s*true\s*$/m)
    expect(build).not.toMatch(/^\s*no-cache:\s*false\s*$/m)
  })

  it("builds only Dockerfile.opencode for linux/amd64, without pushing", () => {
    const text = workflow()
    expect(text).toContain("uses: docker/setup-buildx-action@v3")
    const build = stepBlock(text, "uses: docker/build-push-action@v6").join("\n")
    expect(build).toContain("context: .")
    expect(build).toContain("file: deploy/Dockerfile.opencode")
    expect(build).toContain("platforms: linux/amd64")
    expect(build).not.toContain("linux/arm64")
    expect(build).toContain("push: false")
    // amd64 is native on ubuntu-latest; QEMU is only for the release's arm64 leg.
    expect(text).not.toContain("docker/setup-qemu-action")
  })

  it("never pushes an image or asks for registry write access", () => {
    const text = workflow()
    expect(text).not.toContain("packages: write")
    expect(text).not.toContain("docker/login-action")
    const build = stepBlock(text, "uses: docker/build-push-action@v6").join("\n")
    expect(build).not.toMatch(/^\s*tags:/m)
    expect(build).not.toContain("ghcr.io")
    expect(build).not.toContain("GITHUB_TOKEN")
  })

  it("stays read-only at the workflow level", () => {
    const permissions = section(workflow(), "permissions", 0).map((line) => line.trim())
    expect(permissions).toEqual(["contents: read"])
  })

  it("shares the release cache scope so this gate warms what the release consumes", () => {
    const build = stepBlock(workflow(), "uses: docker/build-push-action@v6").join("\n")
    expect(build).toContain("cache-from: type=gha,scope=opencode")
    expect(build).toContain("cache-to: type=gha,mode=max,scope=opencode")

    // The scope is not arbitrary: release.yml publishes an `opencode` image and
    // resolves its cache scope from that matrix entry.
    const release = releaseWorkflow()
    expect(release).toContain("- image: opencode")
    expect(release).toContain("cache-from: type=gha,scope=${{ matrix.image }}")
    expect(release).toContain("cache-to: type=gha,mode=max,scope=${{ matrix.image }}")
  })

  it("keeps the build-time offline smoke in the Dockerfile", () => {
    const text = dockerfile()
    expect(text).toMatch(/RUN --network=none python3 \/opt\/python-smoke\.py/)
    expect(text).toContain("/opt/artifact-tool/packages/python-tool/python")
  })
})
