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
const SWAP = readFileSync(join(ROOT, "deploy/swap.sh"), "utf8")
const ENV_TEMPLATE = readFileSync(join(ROOT, "deploy/env.example"), "utf8")
const ROOT_ENV_TEMPLATE = readFileSync(join(ROOT, ".env.example"), "utf8")

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

  it("mounts the memory volume read-write in the BFF only", () => {
    // Issue #49: the BFF is the single writer. OpenCode gets no memory mount —
    // an early root-mounted volume would seed root-owned 0600 files the BFF
    // (uid 1000) could never write.
    expect(service("bff")).toMatch(/^\s*- memory-data:\/workspace\/\.memory$/m)
    const mounters = [...SERVICES]
      .filter(([, block]) => /^\s*- memory-data:\/workspace\/\.memory/m.test(block))
      .map(([name]) => name)
    expect(mounters).toEqual(["bff"])
    expect(COMPOSE).toMatch(/^ {2}memory-data:\s*$/m)
  })

  it("forwards the memory and chat knobs the env template documents", () => {
    // Issue #43, finding 2: the BFF environment is a whitelist, not an
    // `env_file`, so a documented knob must be listed here or it never reaches
    // the process. The defaults match `.env.example`.
    const expected: Array<[string, string]> = [
      ["MEMORY_MAX_FACTS_BYTES", "${MEMORY_MAX_FACTS_BYTES:-8388608}"],
      ["CHAT_CONTEXT_SOFT_CAP", "${CHAT_CONTEXT_SOFT_CAP:-200000}"],
      ["FALLBACK_CHAIN_JSON", "${FALLBACK_CHAIN_JSON:-}"],
      ["FALLBACK_PAID_DAILY_CAP", "${FALLBACK_PAID_DAILY_CAP:-0}"],
      ["FALLBACK_USAGE_DIR", "${FALLBACK_USAGE_DIR:-/workspace/chats/.usage}"],
    ]
    for (const [key, value] of expected) {
      expect(service("bff"), `bff must forward ${key}`).toContain(`${key}: ${value}`)
      expect(ROOT_ENV_TEMPLATE, `.env.example must document ${key}`).toMatch(
        new RegExp(`^${key}=`, "m"),
      )
    }
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
      "MEMORY_INTERNAL_TOKEN",
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
    for (const key of ["OPENCHAT_PASSWORD", "OPENCHAT_PASSWORD_HASH", "SESSION_SECRET", "OPENCODE_PASSWORD", "CODE_TICKET_SECRET", "ARTIFACT_SIGNING_KEY", "ARTIFACT_INTERNAL_TOKEN", "MEMORY_INTERNAL_TOKEN", "DOCUMENTS_TOKEN", "STT_API_KEY"]) {
      expect(ENV_TEMPLATE, `${key} must stay empty in the template`).toMatch(
        new RegExp(`^${key}=$`, "m"),
      )
    }
    expect(ENV_TEMPLATE).toMatch(/^APP_ORIGIN=https:\/\//m)

    // The root template documents the new internal token as an empty value;
    // it is a reference, never a committed secret.
    expect(ROOT_ENV_TEMPLATE).toMatch(/^MEMORY_INTERNAL_TOKEN=$/m)
    expect(ROOT_ENV_TEMPLATE).toContain("POST /internal/memory")
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

  it("bind-mounts the memory disk read-write in the BFF and nowhere else", () => {
    expect(remote("bff")).toMatch(/^\s*- \/opt\/stacks\/openchat\/disks\/memory:\/workspace\/\.memory$/m)
    const mounters = [...REMOTE_SERVICES]
      .filter(([, block]) => /disks\/memory:\/workspace\/\.memory/m.test(block))
      .map(([name]) => name)
    expect(mounters).toEqual(["bff"])
    // The gate reads the marker inside the image, never the memory store.
    expect(remote("disks-ready")).toMatch(/^\s*- \/opt\/stacks\/openchat\/disks\/memory:\/disks\/memory:ro$/m)
  })

  it("repeats the fact-store cap on the production overlay", () => {
    // The overlay owns the production environment; the base file's default is
    // not enough if a later edit changes one without the other.
    expect(remote("bff")).toContain("MEMORY_MAX_FACTS_BYTES: ${MEMORY_MAX_FACTS_BYTES:-8388608}")
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

  it("gives the memory token to the BFF and the tool's host, and to nothing else", () => {
    // The memory MCP tool is a thin client: the token authorizes POST
    // /internal/memory and never appears in the public allowlist.
    const holders = [...SERVICES]
      .filter(([, block]) => block.includes("MEMORY_INTERNAL_TOKEN"))
      .map(([name]) => name)
      .sort()
    expect(holders).toEqual(["bff", "opencode"])
    expect(service("bff")).toContain("MEMORY_INTERNAL_TOKEN: ${MEMORY_INTERNAL_TOKEN:?")
    expect(service("opencode")).toContain("MEMORY_INTERNAL_TOKEN: ${MEMORY_INTERNAL_TOKEN:?")
  })
})

describe("compose interpolation of required values", () => {
  it("refuses to start without the three shared secrets", () => {
    for (const key of ["SESSION_SECRET", "OPENCODE_PASSWORD", "ARTIFACT_SIGNING_KEY", "CODE_TICKET_SECRET", "MEMORY_INTERNAL_TOKEN"]) {
      expect(COMPOSE).toContain(`\${${key}:?`)
    }
  })

  it("passes the same OpenCode credential to the BFF and the Code host", () => {
    expect(service("bff")).toContain("OPENCODE_PASSWORD: ${OPENCODE_PASSWORD:?")
    expect(service("code-host")).toContain("OPENCODE_PASSWORD: ${OPENCODE_PASSWORD:?")
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
