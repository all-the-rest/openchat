import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const WORKFLOW = join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "release.yml")

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8")
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

describe("release workflow", () => {
  it("runs on v tags and on a dry-run dispatch only", () => {
    const text = workflow()
    expect(text).toContain("push:\n    tags: [\"v*\"]")
    expect(text).toContain("workflow_dispatch:")
    expect(text).toContain("type: boolean")
    expect(text).toContain("default: true")
    expect(text).not.toContain("pull_request")
  })

  it("requests the minimal permissions and only GITHUB_TOKEN", () => {
    const text = workflow()
    expect(permissionsBlock(text)).toEqual(["contents: write", "packages: write"])
    const secrets = [...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((match) => match[1])
    expect(new Set(secrets)).toEqual(new Set(["GITHUB_TOKEN"]))
    expect(text).not.toContain("id-token")
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
