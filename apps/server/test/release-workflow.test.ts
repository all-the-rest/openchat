import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const WORKFLOW = join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "release.yml")
const COMPOSE = join(import.meta.dirname, "..", "..", "..", "compose.yaml")

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8")
}

interface ComposeService {
  name: string
  image: string | null
  built: boolean
}

/** Services in `compose.yaml`, with their image and whether compose builds them. */
function composeServices(text: string): ComposeService[] {
  const services: ComposeService[] = []
  let current: ComposeService | null = null
  for (const line of text.split("\n")) {
    const name = /^ {2}([a-z][a-z0-9-]*):$/.exec(line)
    if (name) {
      if (current) services.push(current)
      current = { name: name[1] ?? "", image: null, built: false }
      continue
    }
    if (current === null) continue
    const image = /^ {4}image: (\S+)$/.exec(line)
    if (image) current.image = image[1] ?? null
    if (/^ {4}build:/.test(line)) current.built = true
  }
  if (current) services.push(current)
  return services
}

/**
 * Repository images compose builds, with the release tag variable removed:
 * `openchat-tools:${OPENCHAT_TAG:-local}` becomes `openchat-tools`. Services
 * without a `build:` block (the OpenCode and dind images) come from upstream;
 * this test holds the images compose builds here to the release matrix.
 */
function composeReleaseImages(compose: string): string[] {
  return composeServices(compose)
    .filter((service) => service.built && service.image !== null)
    .map((service) => (service.image ?? "").replace(/:?\$\{OPENCHAT_TAG[^}]*\}/, ""))
}

function workflowMatrixImages(text: string): string[] {
  return [...text.matchAll(/^ +- image: (\S+)$/gm)].map((match) => match[1] ?? "")
}

function permissionsBlock(text: string): string[] {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line === "permissions:")
  expect(start).toBeGreaterThan(-1)
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) continue
    if (/^\S/.test(line)) break
    block.push(line.trim())
  }
  return block
}

/** One job's YAML block, from its 2-space key to the next job. */
function jobBlock(text: string, job: string): string {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line === `  ${job}:`)
  expect(start, `${job} job`).toBeGreaterThan(-1)
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[a-z][a-z-]*:$/.test(line)) break
    block.push(line)
  }
  return block.join("\n")
}

describe("release workflow", () => {
  it("runs on v tags and on a dry-run dispatch only", () => {
    const text = workflow()
    expect(text).toContain("push:\n    tags: [\"v*\"]")
    expect(text).toContain("workflow_dispatch:")
    expect(text).toContain("type: boolean")
    expect(text).toContain("default: true")
    expect(text).not.toContain("pull_request")
  })

  it("keeps the workflow read-only and scopes the writes to their jobs", () => {
    const text = workflow()
    expect(permissionsBlock(text)).toEqual(["contents: read"])
    const secrets = [...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((match) => match[1])
    expect(new Set(secrets)).toEqual(new Set(["GITHUB_TOKEN"]))
    expect(text).not.toContain("id-token")

    // `contents: write` appears once, in the job that creates the release.
    expect(text.match(/contents: write/g)).toHaveLength(1)
    expect(jobBlock(text, "github-release")).toContain("contents: write")
    expect(jobBlock(text, "images")).toContain("packages: write")
    for (const job of ["version", "gates"]) {
      expect(jobBlock(text, job)).not.toContain("write")
    }
  })

  it("runs the fast gates before any image is built", () => {
    const text = workflow()
    const gates = text.indexOf("pnpm run gates:fast")
    const build = text.indexOf("docker/build-push-action")
    expect(gates).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(-1)
    expect(gates).toBeLessThan(build)
    expect(text).toContain("needs: [version, gates]")
  })

  it("builds every Dockerfile the stack references for amd64 and arm64", () => {
    const text = workflow()
    for (const dockerfile of [
      "deploy/Dockerfile.bff",
      "deploy/Dockerfile.code-host",
      "deploy/Dockerfile.artifact-host",
      "deploy/Dockerfile.opencode",
      "deploy/code-host/tools.Dockerfile",
    ]) {
      expect(text).toContain(dockerfile)
    }
    expect(text).toContain("platforms: linux/amd64,linux/arm64")
    expect(text).toContain("provenance: true")
    expect(text).toContain("sbom: true")
    expect(text).toContain("docker/setup-buildx-action@v3")
  })

  it("lists every compose build file and no file that does not exist", () => {
    const text = workflow()
    const root = join(import.meta.dirname, "..", "..", "..")
    const matrix = [...text.matchAll(/^\s+dockerfile: (\S+)$/gm)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    )
    expect(matrix.length).toBeGreaterThanOrEqual(5)
    for (const file of matrix) {
      expect(existsSync(join(root, file)), `${file} must exist`).toBe(true)
    }

    const compose = ["compose.yaml", "deploy/remote/compose.yaml"]
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n")
    const referenced = [...compose.matchAll(/^\s+dockerfile: (\S+)$/gm)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    )
    expect(referenced.length).toBeGreaterThanOrEqual(5)
    for (const file of referenced) {
      expect(matrix, `${file} must be in the release matrix`).toContain(file)
    }
  })

  it("tags the GHCR coordinates with the version and latest", () => {
    const text = workflow()
    expect(text).toContain("IMAGE_PREFIX: ghcr.io/all-the-rest/openchat")
    expect(text).toContain("${{ env.IMAGE_PREFIX }}/${{ matrix.image }}:${{ needs.version.outputs.version }}")
    expect(text).toContain("${{ env.IMAGE_PREFIX }}/${{ matrix.image }}:latest")
  })

  it("publishes every image compose builds from this repository", () => {
    const expected = composeReleaseImages(readFileSync(COMPOSE, "utf8")).map((image) =>
      image.replace(/^openchat-/, ""),
    )
    expect(expected.length).toBeGreaterThan(0)

    const built = workflowMatrixImages(workflow())
    for (const image of expected) {
      expect(
        built,
        `compose.yaml builds openchat-${image}; the release matrix must publish it, or --prepare pull has no image`,
      ).toContain(image)
    }
  })

  it("never pushes or releases from a non-tag ref", () => {
    const text = workflow()
    const pushLines = text
      .split("\n")
      .filter((line) => line.trimStart().startsWith("push: ${{"))
    expect(pushLines).toHaveLength(1)
    expect(pushLines[0]).toContain("github.ref_type == 'tag'")
    expect(pushLines[0]).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(pushLines[0]).toContain("inputs.dry_run != true")

    const login = text.slice(text.indexOf("Log in to GHCR"), text.indexOf("Build ${{ matrix.image }}"))
    expect(login).toContain("if: github.ref_type == 'tag'")
    expect(login).toContain("inputs.dry_run != true")

    const release = text.slice(text.indexOf("github-release:"))
    expect(release).toContain("if: github.ref_type == 'tag'")
    expect(release).toContain("startsWith(github.ref, 'refs/tags/v')")
  })

  it("creates the GitHub release from the changelog section", () => {
    const text = workflow()
    expect(text).toContain("gh release create")
    expect(text).toContain("--notes-file release-notes.md")
    expect(text).toContain("--verify-tag")
    expect(text).toContain("CHANGELOG.md has no section for")
    expect(text).toContain("tag ${GITHUB_REF_NAME} does not match VERSION")
  })
})
