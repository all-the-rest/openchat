import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ROOT, serviceBlock } from "./remote-deploy-fixtures"

/**
 * Follow-ups 9 and 10 of #43: the `disks-ready` gate image is pinned by digest,
 * and `mem_reservation` (`memory.low`) is sized to ~2x the measured working set
 * from #44 instead of the old 1.1 GiB of reclaim protection.
 */

const REMOTE = readFileSync(join(ROOT, "deploy", "remote", "compose.yaml"), "utf8")
const DOC = readFileSync(join(ROOT, "docs", "implementation", "20-remote-deploy.md"), "utf8")

/** Multi-arch index digest from `docker buildx imagetools inspect alpine:3`. */
const ALPINE_INDEX_DIGEST =
  "sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf"

describe("pinned disks-ready image", () => {
  it("uses alpine:3 with a 64-hex index digest", () => {
    const gate = serviceBlock(REMOTE, "disks-ready")
    expect(gate).toContain(`image: alpine:3@${ALPINE_INDEX_DIGEST}`)
    expect(gate).toMatch(/image: alpine:3@sha256:[0-9a-f]{64}\n/)
  })

  it("never uses latest in an effective compose line", () => {
    const effective = REMOTE.split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n")
    expect(effective).not.toMatch(/:latest\b/)
    expect(effective).not.toMatch(/^\s+image:\s*\S*latest/m)
  })

  it("documents the exact bump command", () => {
    expect(DOC).toContain("docker buildx imagetools inspect alpine:3")
    expect(DOC).toContain(ALPINE_INDEX_DIGEST)
  })
})

describe("memory reservations", () => {
  const reservations: Record<string, string> = {
    bff: "32m",
    "code-host": "160m",
    "artifact-host": "32m",
    opencode: "384m",
    toolbox: "192m",
    dind: "512m",
  }

  it("pins ~2x the measured working set and leaves toolbox/dind alone", () => {
    for (const [service, value] of Object.entries(reservations)) {
      expect(serviceBlock(REMOTE, service), `${service} reservation`).toContain(
        `mem_reservation: ${value}`,
      )
    }
  })

  it("keeps every mem_limit unchanged", () => {
    const limits: Record<string, string> = {
      bff: "512m",
      "code-host": "256m",
      "artifact-host": "128m",
      opencode: "1536m",
      toolbox: "512m",
      dind: "1024m",
    }
    for (const [service, value] of Object.entries(limits)) {
      expect(serviceBlock(REMOTE, service), `${service} limit`).toContain(`mem_limit: ${value}`)
    }
  })

  it("states the measured values and the new total in the runbook", () => {
    expect(DOC).toContain("bff 16 MiB")
    expect(DOC).toContain("code-host 70 MiB")
    expect(DOC).toContain("artifact-host")
    expect(DOC).toContain("opencode 84 MiB")
    expect(DOC).toContain("608 MiB total")
  })
})
