import { describe, expect, it, vi } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { SearchSource } from "@openchat/contracts"
import type { OpenCodeClient } from "@opencode/client"
import { FakeBackend } from "../src"
import { liveSearch } from "../src/live-search"
import { LiveBackend } from "../src/live"

const ALL: SearchSource[] = ["chats", "workspace", "web", "apps"]

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Prompts and waits until the run is terminal, so message text is stored. */
async function promptAndWait(backend: FakeBackend, sessionID: string, text: string): Promise<void> {
  const controller = new AbortController()
  const done = (async () => {
    for await (const event of backend.subscribe(controller.signal)) {
      if (
        event.type === EVENT.executionSucceeded ||
        event.type === EVENT.executionFailed ||
        event.type === EVENT.interrupted
      ) {
        controller.abort()
        return
      }
    }
  })()
  await backend.prompt(sessionID, { text })
  await withTimeout(done, 2000)
}

describe("fake search", () => {
  it("finds a chat by title and a message by its text", async () => {
    const backend = new FakeBackend({ delayMs: 0, workspace: "/workspace" })
    const session = await backend.createSession({ title: "Alpha planning", directory: "/workspace" })
    await promptAndWait(backend, session.id, "Let us talk about beta today")

    const byTitle = await backend.search({ query: "alpha", sources: ["chats"], limit: 10 })
    expect(byTitle.hits).toContainEqual({
      source: "chats",
      id: `chat-${session.id}`,
      title: "Alpha planning",
      sessionID: session.id,
    })

    const byText = await backend.search({ query: "beta", sources: ["chats"], limit: 10 })
    const messageHit = byText.hits.find((hit) => hit.messageID !== undefined)
    expect(messageHit).toMatchObject({
      source: "chats",
      title: "Alpha planning",
      sessionID: session.id,
    })
    expect(messageHit?.snippet).toContain("beta")
  })

  it("groups workspace, web and app hits with their source fields", async () => {
    const backend = new FakeBackend({ delayMs: 0 })

    const workspace = await backend.search({ query: "product-scope", sources: ["workspace"], limit: 10 })
    expect(workspace.hits[0]).toMatchObject({
      source: "workspace",
      title: "docs/spec/01-product-scope.md",
      path: "docs/spec/01-product-scope.md",
    })

    const web = await backend.search({ query: "opencode", sources: ["web"], limit: 10 })
    expect(web.hits.length).toBeGreaterThan(0)
    expect(web.hits[0]).toMatchObject({ source: "web", provider: "fake" })
    expect(web.hits[0]?.url).toMatch(/^https:\/\/example\.test\//)

    const apps = await backend.search({ query: "github", sources: ["apps"], limit: 10 })
    expect(apps.hits).toEqual([
      {
        source: "apps",
        id: "app-server-github",
        title: "GitHub",
        snippet: "Issues, pull requests and repository search.",
        app: "github",
        appKind: "server",
        status: "needs_auth",
      },
    ])
  })

  it("queries only the requested sources and caps every group", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    await backend.createSession({ title: "One", directory: "/workspace" })
    await backend.createSession({ title: "Two", directory: "/workspace" })

    const appsOnly = await backend.search({ query: "e", sources: ["apps"], limit: 10 })
    expect(new Set(appsOnly.hits.map((hit) => hit.source))).toEqual(new Set(["apps"]))

    const capped = await backend.search({ query: "e", sources: ALL, limit: 1 })
    for (const source of ALL) {
      expect(capped.hits.filter((hit) => hit.source === source).length).toBeLessThanOrEqual(1)
    }
  })

  it("reports a disabled source without searching it", async () => {
    const backend = new FakeBackend({ delayMs: 0, disabledSources: ["web"] })
    const outcome = await backend.search({ query: "opencode", sources: ALL, limit: 10 })

    expect(outcome.available).toEqual(["chats", "workspace", "apps"])
    expect(outcome.hits.some((hit) => hit.source === "web")).toBe(false)
    expect(outcome.failed).toEqual([])
  })

  it("isolates a failing source from the others", async () => {
    const backend = new FakeBackend({ delayMs: 0, failingSources: ["workspace"] })
    const outcome = await backend.search({ query: "opencode", sources: ALL, limit: 10 })

    expect(outcome.failed).toEqual(["workspace"])
    expect(outcome.hits.some((hit) => hit.source === "workspace")).toBe(false)
    expect(outcome.hits.some((hit) => hit.source === "web")).toBe(true)
  })
})

interface StubOptions {
  providers?: Array<{ id: string; name: string }>
  providersFail?: boolean
  queryFail?: boolean
  mcpFail?: boolean
  skillsFail?: boolean
}

function stubClient(options: StubOptions = {}) {
  const list = vi.fn(async (input: { search?: string; limit?: number }) => ({
    data: [{ id: "ses_live", title: input.search ? `${input.search} chat` : "Chat" }],
  }))
  const find = vi.fn(async () => ({
    data: [{ path: "src/live.ts", type: "file" as const }],
  }))
  const providers = vi.fn(async () => {
    if (options.providersFail) throw new Error("Transport")
    return { data: options.providers ?? [{ id: "exa", name: "Exa" }] }
  })
  const query = vi.fn(async () => {
    if (options.queryFail) throw new Error("Provider down")
    return {
      data: {
        providerID: "exa",
        results: [
          {
            url: "https://example.test/live",
            title: "Live result",
            content: "A result from the host's configured provider.",
            time: { published: 1_700_000_000 },
          },
        ],
      },
    }
  })
  const mcpList = vi.fn(async () => {
    if (options.mcpFail) throw new Error("MCP unavailable")
    return {
      data: [
        { name: "filesystem", title: "Filesystem", status: { status: "connected" } },
      ],
    }
  })
  const skillList = vi.fn(async () => {
    if (options.skillsFail) throw new Error("Skills unavailable")
    return {
      data: [{ id: "review", name: "review", description: "Review a diff", path: "/skills/review" }],
    }
  })
  const client = {
    session: { list },
    file: { find },
    websearch: { providers, query },
    mcp: { list: mcpList },
    skill: { list: skillList },
  } as unknown as OpenCodeClient
  return { client, sessionList: list, fileFind: find, providers, query, mcpList, skillList }
}

describe("live search", () => {
  it("maps host results and marks every configured source available", async () => {
    const { client, sessionList, fileFind, query, mcpList, skillList } = stubClient()
    const outcome = await liveSearch(client, "/workspace", {
      query: "file",
      sources: ALL,
      limit: 10,
    })

    expect(sessionList).toHaveBeenCalledWith({
      directory: "/workspace",
      search: "file",
      limit: 10,
    })
    expect(fileFind).toHaveBeenCalledWith({
      location: { directory: "/workspace" },
      query: "file",
      limit: 10,
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(mcpList).toHaveBeenCalledWith({ location: { directory: "/workspace" } })
    expect(skillList).toHaveBeenCalledWith({ location: { directory: "/workspace" } })
    expect(outcome.available).toEqual(ALL)
    expect(outcome.failed).toEqual([])
    expect(outcome.hits).toContainEqual({
      source: "chats",
      id: "chat-ses_live",
      title: "file chat",
      sessionID: "ses_live",
    })
    expect(outcome.hits).toContainEqual({
      source: "workspace",
      id: "file-src/live.ts",
      title: "src/live.ts",
      path: "src/live.ts",
    })
    expect(outcome.hits).toContainEqual({
      source: "web",
      id: "https://example.test/live",
      title: "Live result",
      snippet: "A result from the host's configured provider.",
      url: "https://example.test/live",
      provider: "exa",
      published: 1_700_000_000,
    })
    expect(outcome.hits).toContainEqual({
      source: "apps",
      id: "app-server-filesystem",
      title: "Filesystem",
      app: "filesystem",
      appKind: "server",
      status: "connected",
    })
  })

  it("does not query web when the host configures no provider", async () => {
    const { client, query } = stubClient({ providers: [] })
    const outcome = await liveSearch(client, "/workspace", {
      query: "live",
      sources: ALL,
      limit: 5,
    })

    expect(outcome.available).toEqual(["chats", "workspace", "apps"])
    expect(outcome.hits.some((hit) => hit.source === "web")).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })

  it("reports web failed when the provider probe is unreachable and web was asked for", async () => {
    const { client } = stubClient({ providersFail: true })
    const outcome = await liveSearch(client, "/workspace", {
      query: "live",
      sources: ALL,
      limit: 5,
    })

    expect(outcome.failed).toEqual(["web"])
    expect(outcome.hits.some((hit) => hit.source === "web")).toBe(false)
    expect(outcome.hits.some((hit) => hit.source === "chats")).toBe(true)

    // `available` describes the deployment, not this request: asking for chats
    // alone must report the same source list.
    const withoutWeb = await liveSearch(client, "/workspace", {
      query: "live",
      sources: ["chats"],
      limit: 5,
    })
    expect(withoutWeb.available).toEqual(outcome.available)
    expect(withoutWeb.failed).toEqual([])
  })

  it("caps live web results and does not query a source twice", async () => {
    const { client, sessionList, query } = stubClient()
    query.mockResolvedValue({
      data: {
        providerID: "exa",
        results: [
          { url: "https://example.test/1", title: "One", time: {} },
          { url: "https://example.test/2", title: "Two", time: {} },
        ],
      },
    } as never)

    const outcome = await liveSearch(client, "/workspace", {
      query: "live",
      sources: ["chats", "chats", "web"],
      limit: 1,
    })

    expect(sessionList).toHaveBeenCalledTimes(1)
    expect(outcome.hits.filter((hit) => hit.source === "web")).toHaveLength(1)
  })

  it("still returns skills when only the MCP list fails", async () => {
    const { client } = stubClient({ queryFail: true, mcpFail: true })
    const outcome = await liveSearch(client, "/workspace", {
      query: "review",
      sources: ALL,
      limit: 5,
    })

    expect(outcome.failed).toEqual(["web"])
    expect(outcome.hits).toContainEqual(
      expect.objectContaining({ source: "apps", appKind: "skill", app: "review" }),
    )
    expect(outcome.hits.some((hit) => hit.source === "chats")).toBe(true)
  })

  it("reports apps failed when both app lists fail", async () => {
    const { client } = stubClient({ mcpFail: true, skillsFail: true })
    const outcome = await liveSearch(client, "/workspace", {
      query: "live",
      sources: ALL,
      limit: 5,
    })

    expect(outcome.failed).toEqual(["apps"])
    expect(outcome.hits.some((hit) => hit.source === "apps")).toBe(false)
    expect(outcome.hits.some((hit) => hit.source === "chats")).toBe(true)
  })

  it("queries only the requested sources", async () => {
    const { client, sessionList, fileFind } = stubClient()
    await liveSearch(client, "/workspace", { query: "live", sources: ["chats"], limit: 5 })

    expect(sessionList).toHaveBeenCalledTimes(1)
    expect(fileFind).not.toHaveBeenCalled()
  })

  it("is wired into LiveBackend", async () => {
    const { client } = stubClient()
    const backend = new LiveBackend({
      baseUrl: "http://127.0.0.1:4096",
      password: "secret",
      workspace: "/workspace",
      client,
    })
    const outcome = await backend.search({ query: "live", sources: ["chats"], limit: 3 })
    expect(outcome.hits[0]).toMatchObject({ source: "chats", sessionID: "ses_live" })
  })
})
