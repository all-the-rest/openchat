import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const IMAGES = {
  bff: readFileSync(join(ROOT, "deploy/Dockerfile.bff"), "utf8"),
  codeHost: readFileSync(join(ROOT, "deploy/Dockerfile.code-host"), "utf8"),
  artifactHost: readFileSync(join(ROOT, "deploy/Dockerfile.artifact-host"), "utf8"),
  tools: readFileSync(join(ROOT, "deploy/code-host/tools.Dockerfile"), "utf8"),
}

describe("image invariants", () => {
  const APP_IMAGES = { bff: IMAGES.bff, codeHost: IMAGES.codeHost, artifactHost: IMAGES.artifactHost }

  for (const [name, text] of Object.entries(APP_IMAGES)) {
    describe(name, () => {
      it("uses a digest-pinned Node 24 base in a multi-stage build", () => {
        expect(text).toMatch(/FROM \$\{NODE_IMAGE\}/)
        expect(text).toMatch(/ARG NODE_IMAGE=node:24-bookworm-slim@sha256:[0-9a-f]{64}/)
        const stages = text.match(/^FROM .*$/gm) ?? []
        expect(stages.length).toBeGreaterThanOrEqual(2)
        for (const stage of stages) {
          if (stage.includes("${NODE_IMAGE}")) continue
          expect(stage, "every literal FROM must be pinned").toMatch(/@sha256:[0-9a-f]{64}/)
        }
      })

      it("installs with a frozen lockfile", () => {
        expect(text).toContain("pnpm install --frozen-lockfile")
        expect(text).not.toMatch(/pnpm install(?! --frozen-lockfile)/)
      })

      it("runs as a non-root user with an init that forwards signals", () => {
        expect(text).toMatch(/^USER node$/m)
        expect(text).not.toMatch(/^USER (?:root|0)$/m)
        expect(text).toMatch(/tini/)
        expect(text).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m)
        expect(text).toMatch(/^HEALTHCHECK /m)
      })

      it("ships no development dependencies in the runtime layer", () => {
        const runtime = text.slice(text.lastIndexOf("FROM ${NODE_IMAGE} AS runtime"))
        expect(runtime).not.toMatch(/pnpm install|npm install --global pnpm/)
        expect(text).not.toContain("NODE_ENV=development")
      })
    })
  }

  it("builds only the workspace subset each image needs", () => {
    expect(IMAGES.bff).toContain("--filter @openchat/server... --filter @openchat/web...")
    expect(IMAGES.codeHost).toContain("--filter @openchat/code-host...")
    expect(IMAGES.artifactHost).toContain("--filter @openchat/artifact-host...")
  })

  // A fresh named volume is seeded from the first image that mounts it, and the
  // artifact host mounts `artifacts` before the BFF. Root-owned seed bytes would
  // make every write from the BFF (uid 1000) fail with EACCES.
  it("seeds the artifact volume with the writer's ownership", () => {
    const runtime = IMAGES.artifactHost.slice(
      IMAGES.artifactHost.lastIndexOf("FROM ${NODE_IMAGE} AS runtime"),
    )
    expect(runtime).toMatch(/mkdir -p \/artifacts/)
    expect(runtime).toMatch(/chown node:node \/artifacts/)
    expect(runtime.indexOf("chown node:node /artifacts")).toBeLessThan(
      runtime.indexOf("USER node"),
    )
  })

  // The single-writer model (§6.1) depends on a fresh memory-data volume being
  // seeded as node:node with directory mode 0700 — a root-owned volume would
  // make every write from the BFF fail with EACCES.
  it("seeds the memory volume with the writer's ownership and a traversable mode", () => {
    const runtime = IMAGES.bff.slice(IMAGES.bff.lastIndexOf("FROM ${NODE_IMAGE} AS runtime"))
    expect(runtime).toMatch(/mkdir -p [^\n]*\/workspace\/\.memory/)
    expect(runtime).toMatch(/chown -R node:node [^\n]*\/workspace\/\.memory/)
    expect(runtime).toMatch(/chmod 700 \/workspace\/\.memory/)
    expect(runtime.indexOf("chown -R node:node")).toBeLessThan(runtime.indexOf("USER node"))
    expect(runtime.indexOf("chmod 700 /workspace/.memory")).toBeLessThan(
      runtime.indexOf("USER node"),
    )
  })

  it("gives the tool runtime a shell toolchain and a non-privileged docker CLI", () => {
    expect(IMAGES.tools).toMatch(/^ARG NODE_IMAGE=node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m)
    expect(IMAGES.tools).toMatch(/\bgit\b/)
    expect(IMAGES.tools).toMatch(/\bgh\b/)
    expect(IMAGES.tools).toMatch(/\bripgrep\b/)
    expect(IMAGES.tools).toMatch(/pnpm@11/)
    expect(IMAGES.tools).toContain("docker-${DOCKER_CLI_VERSION}.tgz")
    expect(IMAGES.tools).not.toMatch(/apt-get install[^\n]*\bdocker\.io\b/)
    expect(IMAGES.tools).toMatch(/^USER node$/m)
    expect(IMAGES.tools).toMatch(/^HEALTHCHECK /m)
    expect(IMAGES.tools).not.toMatch(/^\s*privileged:/m)
    expect(IMAGES.tools).not.toMatch(/--privileged/)
  })

  it("verifies the docker CLI tarball against the release checksum before unpacking", () => {
    expect(IMAGES.tools).toContain("${tarball}.sha256")
    expect(IMAGES.tools).toContain('sha256sum -c "${tarball}.sha256"')
    expect(IMAGES.tools.indexOf("sha256sum -c")).toBeLessThan(
      IMAGES.tools.indexOf("tar -xz"),
    )
  })

  it("never copies a .env or a secret into an image", () => {
    for (const [name, text] of Object.entries(IMAGES)) {
      expect(text, `${name} must not copy .env`).not.toMatch(/^COPY .*\.env/m)
      expect(text, `${name} must not bake a secret`).not.toMatch(/ENV .*(?:PASSWORD|SECRET|SIGNING_KEY)=/)
    }
  })
})
