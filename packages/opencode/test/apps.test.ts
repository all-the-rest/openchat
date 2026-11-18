import { describe, expect, it, vi } from "vitest"
import type { AppServer } from "@openchat/contracts"
import type { OpenCodeClient } from "@opencode/client"
import { BackendError, FakeBackend } from "../src"
import { LiveBackend } from "../src/live"

const WORKSPACE = "/workspace"

const SERVERS = [
  { name: "filesystem", title: " Filesystem ", status: { status: "connected" as const } },
  { name: "local", status: { status: "pending" as const } },
  { name: "notes", status: { status: "disabled" as const } },
  {
    name: "postgres",
    status: { status: "failed" as const, error: "Connection refused after 3 attempts." },
  },
  {
    name: "github",
    title: "GitHub",
    integrationID: "github",
    status: { status: "needs_auth" as const, error: "The OAuth token is missing or expired." },
  },
]

const SKILLS = [
  {
    id: "review",
    name: "Review",
    description: " Review a diff. ",
    autoinvoke: true,
    path: "/workspace/.opencode/skills/review/SKILL.md",
    content: "A large body that must never reach the client.",
  },
  { id: "release", name: "Release" },
]

interface StubOptions {
  servers?: readonly unknown[]
  skills?: readonly unknown[]
  mcpFail?: boolean
  skillsFail?: boolean
  actionFail?: boolean
}

function stubClient(options: StubOptions = {}) {
  const mcpList = vi.fn(async () => {
    if (options.mcpFail) throw new Error("MCP unavailable")
    return { data: options.servers ?? SERVERS }
  })
  const skillList = vi.fn(async () => {
    if (options.skillsFail) throw new Error("Skills unavailable")
    return { data: options.skills ?? SKILLS }
  })
  const connect = vi.fn(async () => {
    if (options.actionFail) throw new Error("upstream said no")
  })
  const disconnect = vi.fn(async () => {
    if (options.actionFail) throw new Error("upstream said no")
  })
  const client = {
    mcp: { list: mcpList },
    skill: { list: skillList },
    experimental: { mcp: { connect, disconnect } },
  } as unknown as OpenCodeClient
  return { client, mcpList, skillList, connect, disconnect }
}

function backendWith(client: OpenCodeClient): LiveBackend {
  return new LiveBackend({ baseUrl: "http://unused", password: "unused", workspace: WORKSPACE, client })
}

function server(servers: AppServer[], name: string): AppServer {
  const found = servers.find((entry) => entry.name === name)
  if (!found) throw new Error(`No server ${name}`)
  return found
}

describe("live apps", () => {
  it("maps every MCP status and keeps the skill body upstream", async () => {
    const { client, mcpList, skillList } = stubClient()
    const snapshot = await backendWith(client).listApps()

    expect(mcpList).toHaveBeenCalledWith({ location: { directory: WORKSPACE } })
    expect(skillList).toHaveBeenCalledWith({ location: { directory: WORKSPACE } })
    expect(snapshot.servers).toEqual([
      { name: "filesystem", title: "Filesystem", status: "connected" },
      { name: "local", status: "pending" },
      { name: "notes", status: "disabled" },
      {
        name: "postgres",
        status: "failed",
        error: "Connection refused after 3 attempts.",
      },
      {
        name: "github",
        title: "GitHub",
        integrationID: "github",
        status: "needs_auth",
        error: "The OAuth token is missing or expired.",
      },
    ])
    expect(snapshot.skills).toEqual([
      { id: "review", name: "Review", description: "Review a diff.", autoinvoke: true },
      { id: "release", name: "Release" },
    ])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain("content")
    expect(serialized).not.toContain("SKILL.md")
  })

  it("keeps the servers when only the skill list fails", async () => {
    const { client } = stubClient({ skillsFail: true })
    const snapshot = await backendWith(client).listApps()
    expect(snapshot.servers).toHaveLength(5)
    expect(snapshot.skills).toEqual([])
  })

  it("keeps the skills when only the MCP list fails", async () => {
    const { client } = stubClient({ mcpFail: true })
    const snapshot = await backendWith(client).listApps()
    expect(snapshot.servers).toEqual([])
    expect(snapshot.skills.map((skill) => skill.id)).toEqual(["review", "release"])
  })

  it("reports the capability as unavailable when both lists fail", async () => {
    const { client } = stubClient({ mcpFail: true, skillsFail: true })
    const failure = await backendWith(client)
      .listApps()
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).code).toBe("unavailable")
  })

  it("bounds and flattens an upstream error", async () => {
    const noisy = `line one\n\tline two ${"x".repeat(400)}\u0000end`
    const { client } = stubClient({
      servers: [{ name: "broken", status: { status: "failed", error: noisy } }],
    })
    const snapshot = await backendWith(client).listApps()
    const error = server(snapshot.servers, "broken").error ?? ""
    expect(error.length).toBeLessThanOrEqual(301)
    expect(error.endsWith("…")).toBe(true)
    expect(error).not.toContain("\n")
    expect(error).not.toContain("\t")
    expect(error).toContain("line one line two")
  })

  it("skips a host row that cannot be a list entry", async () => {
    const { client } = stubClient({
      servers: [
        { name: "filesystem", status: { status: "connected" } },
        { name: "   ", status: { status: "connected" } },
        { status: { status: "connected" } },
        { name: "mystery", status: { status: "half-open" } },
        { name: "no-status", status: {} },
        { name: "broken", status: { status: "failed", error: 42 } },
      ],
    })
    const snapshot = await backendWith(client).listApps()

    // One malformed row must not hide the healthy ones or fail the list.
    expect(snapshot.servers).toEqual([
      { name: "filesystem", status: "connected" },
      { name: "broken", status: "failed" },
    ])
    expect(snapshot.skills).toHaveLength(2)
  })

  it("strips bidi overrides and C1 controls from an error", async () => {
    const { client } = stubClient({
      servers: [
        {
          name: "broken",
          status: { status: "failed", error: "safe\u202eevil\u0085end\ufeff" },
        },
      ],
    })
    const snapshot = await backendWith(client).listApps()

    expect(server(snapshot.servers, "broken").error).toBe("safe evil end")
  })

  it("connects and disconnects by name with the workspace", async () => {
    const { client, connect, disconnect } = stubClient()
    const backend = backendWith(client)

    await backend.connectApp("github")
    expect(connect).toHaveBeenCalledWith({
      server: "github",
      location: { directory: WORKSPACE },
    })
    expect(disconnect).not.toHaveBeenCalled()

    await backend.disconnectApp("github")
    expect(disconnect).toHaveBeenCalledWith({
      server: "github",
      location: { directory: WORKSPACE },
    })
  })

  it("translates a rejected action without forwarding its text", async () => {
    const { client } = stubClient({ actionFail: true })
    const backend = backendWith(client)

    for (const action of [() => backend.connectApp("github"), () => backend.disconnectApp("github")]) {
      const failure = await action().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BackendError)
      expect((failure as BackendError).code).toBe("unavailable")
      expect((failure as BackendError).message).not.toContain("upstream said no")
    }
  })

  it("rejects an empty name before it reaches the host", async () => {
    const { client, connect, disconnect } = stubClient()
    const backend = backendWith(client)

    for (const action of [() => backend.connectApp("  "), () => backend.disconnectApp("")]) {
      const failure = await action().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BackendError)
      expect((failure as BackendError).code).toBe("invalid")
    }
    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })
})

describe("fake apps", () => {
  it("is deterministic and reachable in every status", async () => {
    const backend = new FakeBackend({ delayMs: 0, now: () => 1000 })

    const first = await backend.listApps()
    const second = await backend.listApps()
    expect(first).toEqual(second)
    expect(first.servers.map((entry) => entry.status)).toEqual([
      "connected",
      "needs_auth",
      "failed",
      "disabled",
      "pending",
    ])
    expect(first.skills.map((skill) => skill.id)).toEqual(["review", "release"])
    // `needs_auth` and `failed` are the only states with an error.
    expect(first.servers.filter((entry) => entry.error !== undefined)).toHaveLength(2)
  })

  it("moves a server through connect and disconnect and records the calls", async () => {
    const calls: Array<[string, string]> = []
    const backend = new FakeBackend({
      delayMs: 0,
      onAppAction: (action, name) => calls.push([action, name]),
    })

    await backend.connectApp("github")
    expect(server((await backend.listApps()).servers, "github")).toEqual({
      name: "github",
      title: "GitHub",
      status: "connected",
    })

    await backend.disconnectApp("github")
    expect(server((await backend.listApps()).servers, "github").status).toBe("pending")

    expect(calls).toEqual([
      ["connect", "github"],
      ["disconnect", "github"],
    ])
  })

  it("refuses an unknown server and a disabled one", async () => {
    const backend = new FakeBackend({ delayMs: 0 })

    const unknown = await backend.connectApp("nope").catch((error: unknown) => error)
    expect((unknown as BackendError).code).toBe("not_found")

    const disabled = await backend.connectApp("notes").catch((error: unknown) => error)
    expect((disabled as BackendError).code).toBe("conflict")
    expect(server((await backend.listApps()).servers, "notes").status).toBe("disabled")
  })

  it("reports an absent capability as unsupported", async () => {
    const backend = new FakeBackend({ delayMs: 0, appsAvailable: false })
    const failure = await backend.listApps().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).code).toBe("unsupported")
    // The search source follows the same fact instead of inventing hits.
    const outcome = await backend.search({ query: "github", sources: ["apps"], limit: 10 })
    expect(outcome.available).not.toContain("apps")
    expect(outcome.hits).toEqual([])
  })

  it("keeps a search hit's status in step with the app list", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const before = await backend.search({ query: "github", sources: ["apps"], limit: 10 })
    expect(before.hits[0]).toMatchObject({ app: "github", status: "needs_auth" })

    await backend.connectApp("github")
    const after = await backend.search({ query: "github", sources: ["apps"], limit: 10 })
    expect(after.hits[0]).toMatchObject({ app: "github", status: "connected" })
    expect(server((await backend.listApps()).servers, "github").status).toBe("connected")
  })
})
