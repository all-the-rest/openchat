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
  /**
   * `docker compose config` emits a map for an environment defined in one file
   * and a `KEY=value` list once two files merge the same service, so both shapes
   * are read through `environmentOf`.
   */
  environment?: Record<string, string> | string[]
}

function environmentOf(name: string): Record<string, string> {
  const raw = SERVICES[name]?.environment
  if (raw === undefined) return {}
  if (!Array.isArray(raw)) return raw
  const out: Record<string, string> = {}
  for (const entry of raw) {
    const at = entry.indexOf("=")
    if (at === -1) {
      out[entry] = ""
      continue
    }
    out[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return out
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
const DISK_TARGETS = [
  "/artifacts",
  "/workspace",
  "/workspace/.memory",
  "/home/rootless/.local/share/docker",
  "/root/.local/share/opencode",
]

/** Images that may stay external. Everything else is built from this tree. */
const UPSTREAM = new Set([
  // The rootless daemon is the upstream image, pinned by digest in compose.yaml.
  "dind",
  // The disk gate is a stock `alpine:3` one-shot: four `test -f`, no data.
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

  it("mounts the memory store from its own disk into the BFF alone, read-write", () => {
    // Issue #49: the BFF is the only writer. OpenCode has no memory mount at
    // all, so a root-started container cannot seed a root-owned volume.
    const mounters = Object.entries(SERVICES)
      .filter(([, service]) => service.volumes?.some((m) => m.target === "/workspace/.memory"))
      .map(([name]) => name)
    expect(mounters).toEqual(["bff"])
    const mount = SERVICES.bff?.volumes?.find((m) => m.target === "/workspace/.memory")
    expect(mount?.type).toBe("bind")
    expect(mount?.source).toBe("/opt/stacks/openchat/disks/memory")
    expect(mount?.read_only).not.toBe(true)
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
    expect(environmentOf("documents").DOCUMENTS_TOKEN).toMatch(/^\$\{DOCUMENTS_TOKEN:\?/)
  })

  it("forwards the memory and fallback knobs the template documents to the BFF", () => {
    // Issue #43, finding 2: the BFF environment is an explicit whitelist, so a
    // value in .env that is missing here never reaches the process. The merged
    // config keeps the `${…}` text (`--no-interpolate`), which is the proof that
    // the knob is forwarded and still comes from the env file.
    const env = environmentOf("bff")
    expect(env.MEMORY_MAX_FACTS_BYTES).toBe("${MEMORY_MAX_FACTS_BYTES:-67108864}")
    expect(env.CHAT_CONTEXT_SOFT_CAP).toBe("${CHAT_CONTEXT_SOFT_CAP:-200000}")
    expect(env.FALLBACK_CHAIN_JSON).toBe("${FALLBACK_CHAIN_JSON:-}")
    expect(env.FALLBACK_PAID_DAILY_CAP).toBe("${FALLBACK_PAID_DAILY_CAP:-0}")
    expect(env.FALLBACK_USAGE_DIR).toBe("${FALLBACK_USAGE_DIR:-/workspace/chats/.usage}")
  })

  it("keeps every credential in the merged environment a reference, never a value", () => {
    // `--no-interpolate` cannot leak a secret by accident; this fails if an
    // edit ever inlines one instead of pointing at .env.
    const credential = /(SECRET|TOKEN|PASSWORD|SIGNING_KEY|API_KEY)$/
    for (const name of Object.keys(SERVICES)) {
      for (const [key, value] of Object.entries(environmentOf(name))) {
        if (!credential.test(key)) continue
        expect(value, `${name}.${key} must come from .env`).toMatch(/^\$\{[A-Z_]+:/)
      }
    }
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
