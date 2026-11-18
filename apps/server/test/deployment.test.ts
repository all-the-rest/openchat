import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Static invariants of the deployment layer.
 *
 * These tests read the compose file and the Dockerfiles as text. They cannot
 * prove that an image builds or that a container starts; they pin the security
 * shape that a later edit could silently remove (a published OpenCode port, a
 * writable artifact mount, a privileged container, a secret in the file).
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const COMPOSE = readFileSync(join(ROOT, "compose.yaml"), "utf8")
const IMAGES = {
  bff: readFileSync(join(ROOT, "deploy/Dockerfile.bff"), "utf8"),
  codeHost: readFileSync(join(ROOT, "deploy/Dockerfile.code-host"), "utf8"),
  artifactHost: readFileSync(join(ROOT, "deploy/Dockerfile.artifact-host"), "utf8"),
  tools: readFileSync(join(ROOT, "deploy/code-host/tools.Dockerfile"), "utf8"),
}
const SWAP = readFileSync(join(ROOT, "deploy/swap.sh"), "utf8")
const ENV_TEMPLATE = readFileSync(join(ROOT, "deploy/env.example"), "utf8")

/** Compose service blocks, keyed by name, as raw text. */
function serviceBlocks(source: string): Map<string, string> {
  const blocks = new Map<string, string[]>()
  let inServices = false
  let current: string | undefined

  for (const line of source.split("\n")) {
    if (/^[A-Za-z]/.test(line)) {
      inServices = line.startsWith("services:")
      current = undefined
      continue
    }
    if (!inServices) continue
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    const name = header?.[1]
    if (name !== undefined) {
      current = name
      blocks.set(name, [])
      continue
    }
    if (current !== undefined) blocks.get(current)?.push(line)
  }

  return new Map([...blocks].map(([name, lines]) => [name, lines.join("\n")]))
}

const SERVICES = serviceBlocks(COMPOSE)

function service(name: string): string {
  const block = SERVICES.get(name)
  if (block === undefined) throw new Error(`compose.yaml has no service ${name}`)
  return block
}

function publishedPorts(block: string): string[] {
  const lines = block.split("\n")
  const start = lines.findIndex((line) => line === "    ports:")
  if (start === -1) return []
  const ports: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue
    if (!line.startsWith("      ")) break
    ports.push(line.replace(/^\s*-\s*/, "").replace(/^"|"$/g, "").trim())
  }
  return ports
}

describe("compose stack boundaries", () => {
  it("defines exactly the intended services", () => {
    expect([...SERVICES.keys()].sort()).toEqual([
      "artifact-host",
      "bff",
      "code-host",
      "dind",
      "documents",
      "opencode",
      "toolbox",
    ])
  })

  it("never runs a privileged container", () => {
    for (const [name, block] of SERVICES) {
      expect(block, `${name} must not be privileged`).not.toMatch(/^\s*privileged:\s*true/m)
    }
  })

  it("publishes only the BFF and the artifact origin, on host loopback", () => {
    const published = [...SERVICES].filter(([, block]) => publishedPorts(block).length > 0)
    expect(published.map(([name]) => name).sort()).toEqual(["artifact-host", "bff"])

    for (const [name, block] of published) {
      for (const port of publishedPorts(block)) {
        expect(port, `${name} must bind loopback only`).toMatch(/^127\.0\.0\.1:/)
      }
    }
  })

  it("defaults TRUST_PROXY off because the BFF is published on loopback", () => {
    for (const name of ["bff", "code-host"]) {
      expect(service(name), `${name} must not trust forwarding headers by default`).toMatch(
        /^ {6}TRUST_PROXY: \$\{TRUST_PROXY:-0\}$/m,
      )
    }
    expect(ENV_TEMPLATE).toMatch(/^TRUST_PROXY=0$/m)
    expect(ENV_TEMPLATE).not.toMatch(/^TRUST_PROXY=1$/m)
  })

  it("keeps OpenCode and the Code host unpublished", () => {
    expect(service("opencode")).not.toMatch(/^ {4}ports:/m)
    expect(service("code-host")).not.toMatch(/^ {4}ports:/m)
    for (const [name, block] of SERVICES) {
      for (const port of publishedPorts(block)) {
        expect(port, `${name} must not publish the OpenCode port`).not.toMatch(/:4096$/)
        expect(port, `${name} must not publish the Code host port`).not.toMatch(/:8090$/)
      }
    }
  })

  it("mounts the artifact volume read-only in the host and read-write only in the BFF", () => {
    expect(service("artifact-host")).toMatch(/^\s*- artifacts:\/artifacts:ro$/m)
    expect(service("bff")).toMatch(/^\s*- artifacts:\/artifacts$/m)

    const writers = [...SERVICES].filter(([, block]) =>
      /^\s*- artifacts:\/artifacts:?[^r]*$/m.test(block),
    )
    expect(writers.map(([name]) => name)).toEqual(["bff"])
  })

  it("runs the application containers read-only with a writable tmpfs", () => {
    for (const name of ["bff", "code-host", "artifact-host"]) {
      expect(service(name), `${name} must be read_only`).toMatch(/^ {4}read_only: true$/m)
      expect(service(name), `${name} needs a tmpfs`).toMatch(/^ {6}- \/tmp:/m)
    }
  })

  it("limits memory, cpus, pids and log growth per service", () => {
    for (const name of SERVICES.keys()) {
      const block = service(name)
      expect(block, `${name} needs mem_limit`).toMatch(/^ {4}mem_limit: \S+$/m)
      expect(block, `${name} needs cpus`).toMatch(/^ {4}cpus: \S+$/m)
      expect(block, `${name} needs pids_limit`).toMatch(/^ {4}pids_limit: \d+$/m)
      expect(block, `${name} needs log rotation`).toMatch(/^ {8}max-size: "/m)
      expect(block, `${name} needs restart`).toMatch(/^ {4}restart: \S+/m)
    }
  })

  it("gives every service a healthcheck", () => {
    for (const [name, block] of SERVICES) {
      expect(block, `${name} needs a healthcheck`).toMatch(/^ {4}healthcheck:$/m)
      expect(block, `${name} needs a healthcheck test`).toMatch(/^ {6}test:$/m)
    }
  })

  it("puts the optional services behind profiles", () => {
    for (const name of ["opencode", "toolbox", "dind"]) {
      expect(service(name), `${name} needs a profile`).toMatch(/^ {4}profiles:$/m)
    }
    for (const name of ["bff", "code-host", "artifact-host"]) {
      expect(service(name), `${name} must start by default`).not.toMatch(/^ {4}profiles:$/m)
    }
  })

  it("isolates the artifact origin from OpenCode and the internet", () => {
    const artifacts = service("artifact-host")
    expect(artifacts).not.toMatch(/^\s*- backend$/m)
    expect(artifacts).toMatch(/^\s*- artifacts$/m)
    expect(COMPOSE).toMatch(/^ {2}artifacts:\n {4}internal: true$/m)
    expect(service("dind")).not.toMatch(/^\s*- edge$/m)
  })

  it("keeps every required secret an interpolation, not a value", () => {
    const secretKeys = [
      "SESSION_SECRET",
      "OPENCODE_PASSWORD",
      "CODE_TICKET_SECRET",
      "ARTIFACT_SIGNING_KEY",
      "ARTIFACT_INTERNAL_TOKEN",
      "DOCUMENTS_TOKEN",
    ]
    for (const key of secretKeys) {
      const assignments = [...COMPOSE.matchAll(new RegExp(`^\\s*${key}: (.*)$`, "gm"))]
      expect(assignments.length, `${key} must appear in compose.yaml`).toBeGreaterThan(0)
      for (const assignment of assignments) {
        expect(assignment[1], `${key} must come from .env`).toMatch(/^\$\{[A-Z_]+:\?/)
      }
    }

    // The login credential is one of two shapes; the server refuses a boot with
    // both or neither, so an empty pair fails at start, not at the first login.
    expect(service("bff")).toContain("OPENCHAT_PASSWORD: ${OPENCHAT_PASSWORD:-}")
    expect(service("bff")).toContain("OPENCHAT_PASSWORD_HASH: ${OPENCHAT_PASSWORD_HASH:-}")

    // Optional secrets are still references, never literals.
    expect(COMPOSE).toMatch(/^\s*STT_API_KEY: \$\{STT_API_KEY:-\}$/m)
    expect(COMPOSE).toMatch(/^\s*OPENCHAT_PASSWORD: \$\{OPENCHAT_PASSWORD:-\}$/m)
    expect(COMPOSE).toMatch(
      /^\s*OPENCHAT_PASSWORD_HASH: \$\{OPENCHAT_PASSWORD_HASH:-\}$/m,
    )

    // No obvious credential literal anywhere in the file.
    expect(COMPOSE).not.toMatch(/^.*(?:PASSWORD|SECRET|SIGNING_KEY|API_KEY).*:\s*["']?[A-Za-z0-9+/=]{16,}/m)
    expect(COMPOSE).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  })

  it("keeps the env template secret-free", () => {
    for (const key of ["OPENCHAT_PASSWORD", "OPENCHAT_PASSWORD_HASH", "SESSION_SECRET", "OPENCODE_PASSWORD", "CODE_TICKET_SECRET", "ARTIFACT_SIGNING_KEY", "ARTIFACT_INTERNAL_TOKEN", "DOCUMENTS_TOKEN", "STT_API_KEY"]) {
      expect(ENV_TEMPLATE, `${key} must stay empty in the template`).toMatch(
        new RegExp(`^${key}=$`, "m"),
      )
    }
    expect(ENV_TEMPLATE).toMatch(/^APP_ORIGIN=https:\/\//m)
  })
})

const REMOTE_COMPOSE = readFileSync(join(ROOT, "deploy/remote/compose.yaml"), "utf8")
const REMOTE_SERVICES = serviceBlocks(REMOTE_COMPOSE)

describe("remote overlay storage", () => {
  function remote(name: string): string {
    const block = REMOTE_SERVICES.get(name)
    if (block === undefined) throw new Error(`deploy/remote/compose.yaml has no service ${name}`)
    return block
  }

  it("bind-mounts the artifact disk read-only in the host and read-write only in the BFF", () => {
    expect(remote("bff")).toMatch(/^\s*- \/opt\/stacks\/openchat\/disks\/artifacts:\/artifacts$/m)
    expect(remote("artifact-host")).toMatch(
      /^\s*- \/opt\/stacks\/openchat\/disks\/artifacts:\/artifacts:ro$/m,
    )

    // Consumers see the artifacts at /artifacts; the `disks-ready` gate mounts
    // the same directory read-only at /disks/artifacts to look for its marker.
    const writers = [...REMOTE_SERVICES]
      .filter(([, block]) =>
        /^\s*- \/opt\/stacks\/openchat\/disks\/artifacts:\/artifacts(:\w+)?$/m.test(block),
      )
      .map(([name]) => name)
      .sort()
    expect(writers).toEqual(["artifact-host", "bff"])
  })

  it("shares the workspace read-write with OpenCode and the toolbox, read-only with the BFF", () => {
    expect(remote("bff")).toMatch(/^\s*- \/opt\/stacks\/openchat\/disks\/workspace:\/workspace:ro$/m)
    for (const name of ["opencode", "toolbox"]) {
      expect(remote(name), `${name} needs the workspace`).toMatch(
        /^\s*- \/opt\/stacks\/openchat\/disks\/workspace:\/workspace$/m,
      )
    }
    expect(remote("code-host")).not.toContain("disks/workspace")
  })

  it("caps the rootless daemon's storage with its own disk image", () => {
    expect(remote("dind")).toMatch(
      /^\s*- \/opt\/stacks\/openchat\/disks\/dind:\/home\/rootless\/\.local\/share\/docker$/m,
    )
    // Only the daemon gets the image at its storage path; the gate at
    // /disks/dind reads the marker.
    const others = [...REMOTE_SERVICES].filter(
      ([name, block]) => name !== "dind" && /disks\/dind:\/home\/rootless\/\.local\/share\/docker$/m.test(block),
    )
    expect(others).toEqual([])
  })

  it("gives the artifact token to the BFF and the tool's host, and to nothing else", () => {
    const tokenHolders = [...SERVICES]
      .filter(([, block]) => block.includes("ARTIFACT_INTERNAL_TOKEN"))
      .map(([name]) => name)
      .sort()
    expect(tokenHolders).toEqual(["bff", "opencode"])

    expect(service("opencode")).toContain("OPENCHAT_BFF_URL: ${OPENCHAT_BFF_URL:-http://bff:8787}")
    expect(service("opencode")).toContain("ARTIFACT_INTERNAL_TOKEN: ${ARTIFACT_INTERNAL_TOKEN:?")
    expect(service("bff")).toContain("ARTIFACT_INTERNAL_TOKEN: ${ARTIFACT_INTERNAL_TOKEN:?")
    // Distinct secrets: the signing key signs URLs, the token authorizes writes.
    expect(ENV_TEMPLATE).toMatch(/^ARTIFACT_SIGNING_KEY=$/m)
    expect(ENV_TEMPLATE).toMatch(/^ARTIFACT_INTERNAL_TOKEN=$/m)
  })
})

describe("compose interpolation of required values", () => {
  it("refuses to start without the three shared secrets", () => {
    for (const key of ["SESSION_SECRET", "OPENCODE_PASSWORD", "ARTIFACT_SIGNING_KEY", "CODE_TICKET_SECRET"]) {
      expect(COMPOSE).toContain(`\${${key}:?`)
    }
  })

  it("passes the same OpenCode credential to the BFF and the Code host", () => {
    expect(service("bff")).toContain("OPENCODE_PASSWORD: ${OPENCODE_PASSWORD:?")
    expect(service("code-host")).toContain("OPENCODE_PASSWORD: ${OPENCODE_PASSWORD:?")
  })
})

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

describe("swap script shape", () => {
  it("is strict, plans before it mutates, and reads secrets from the env file", () => {
    expect(SWAP).toContain("set -euo pipefail")
    expect(SWAP).toContain("--env-file")
    expect(SWAP).not.toMatch(/--password|--secret\b/)
    expect(SWAP.indexOf('if [ "$DRY_RUN" -eq 1 ]')).toBeLessThan(
      SWAP.indexOf('compose_from "$RELEASE_REL" config -q'),
    )
  })

  it("validates both probes and can roll back", () => {
    expect(SWAP).toContain("$PROBE_URL/healthz")
    expect(SWAP).toContain("$PROBE_URL/api/info")
    expect(SWAP).toMatch(/ln -sfn "\$target" "\$STACK_DIR\/current"/)
    expect(SWAP).toMatch(/compose_from "\$target" up -d --wait/)
  })
})
