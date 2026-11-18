import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The overlay is additive, so a service added to `compose.yaml` later would run
 * in production with the base file's defaults: no memory cap and named volumes
 * instead of the size-capped loopback images. This merges both files the way
 * the deploy does and asserts the properties the overlay claims.
 *
 * `docker compose config` needs the CLI only, not a daemon. `--no-interpolate`
 * leaves `${…}` as text (no env file, no secret), which is what the image
 * assertion wants: the tag must still be symbolic.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")

interface Mount {
  type: string
  source?: string
  target: string
  read_only?: boolean
}

interface Service {
  image?: string
  mem_limit?: string
  volumes?: Mount[]
  networks?: Record<string, unknown>
  ports?: unknown[]
  environment?: Record<string, string>
}

const MERGED = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      "--file",
      "compose.yaml",
      "--file",
      "deploy/remote/compose.yaml",
      "config",
      "--format",
      "json",
      "--no-interpolate",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ),
) as { services: Record<string, Service> }

const SERVICES = MERGED.services

/** Targets whose storage must come from a loopback ext4 image, not a volume. */
const DISK_TARGETS = ["/artifacts", "/workspace", "/home/rootless/.local/share/docker"]

/** Images that may stay external. Everything else is built from this tree. */
const UPSTREAM = new Set([
  // The rootless daemon is the upstream image, pinned by digest in compose.yaml.
  "dind",
  // The disk gate is a stock `alpine:3` one-shot: three `test -f`, no data.
  "disks-ready",
])

describe("merged remote compose", () => {
  it("limits every service, including one added to the base file later", () => {
    const unlimited = Object.entries(SERVICES)
      .filter(([, service]) => service.mem_limit === undefined)
      .map(([name]) => name)
    expect(unlimited).toEqual([])
  })

  it("mounts the size-capped disks as binds, never as named volumes", () => {
    const wrong: string[] = []
    const seen = new Set<string>()
    for (const [name, service] of Object.entries(SERVICES)) {
      for (const mount of service.volumes ?? []) {
        if (!DISK_TARGETS.includes(mount.target)) continue
        seen.add(mount.target)
        if (mount.type !== "bind" || !mount.source?.startsWith("/opt/stacks/openchat/disks/")) {
          wrong.push(`${name}:${mount.target} is ${mount.type} ${mount.source ?? ""}`)
        }
      }
    }
    expect(wrong).toEqual([])
    // Every disk is covered, so a removed mount cannot pass this test.
    expect([...seen].sort()).toEqual([...DISK_TARGETS].sort())
  })

  it("hands the chat-files subtree to the same directory in every writer", () => {
    // Issue #25: the BFF writes `chats/<session>/files`; the agent and the
    // toolbox must see the same bytes at the same path, on the workspace disk.
    for (const name of ["bff", "opencode", "toolbox"]) {
      const mount = SERVICES[name]?.volumes?.find((entry) => entry.target === "/workspace/chats")
      expect(mount, `${name} needs the chat-files mount`).toBeDefined()
      expect(mount?.type).toBe("bind")
      expect(mount?.source).toBe("/opt/stacks/openchat/disks/workspace/chats")
      // The BFF is the writer; a `:ro` on this one target would fail at runtime.
      expect(mount?.read_only, `${name} writes chat files`).not.toBe(true)
    }
  })

  it("keeps the documents service internal, capped and token-authenticated", () => {
    const documents = SERVICES.documents
    expect(documents).toBeDefined()
    expect(documents?.mem_limit).toBe("1024m")
    expect(documents?.ports).toBeUndefined()
    expect(Object.keys(documents?.networks ?? {})).toEqual(["backend"])
    expect(documents?.environment?.DOCUMENTS_TOKEN).toMatch(/^\$\{DOCUMENTS_TOKEN:\?/)
  })

  it("builds every application image from this tree and only dind from upstream", () => {
    const fromTree = /^openchat-[a-z-]+:\$\{OPENCHAT_TAG(:-local)?\}$/
    for (const [name, service] of Object.entries(SERVICES)) {
      if (UPSTREAM.has(name)) {
        expect(service.image, `${name} must not be replaced by a local build`).not.toMatch(fromTree)
        continue
      }
      expect(service.image, `${name} must come from the local build`).toMatch(fromTree)
    }
  })
})
