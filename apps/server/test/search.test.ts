import { describe, expect, it, vi } from "vitest"
import type { SearchResponse } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

async function runSearch(
  server: TestServer,
  cookie: string,
  query: string,
): Promise<Response> {
  return server.app.request(`/api/search?${query}`, { headers: { cookie } })
}

function groupOf(response: SearchResponse, source: string) {
  return response.groups.find((group) => group.source === source)
}

describe("GET /api/search", () => {
  it("requires authentication before validating the query", async () => {
    const server = makeServer()
    // Invalid on purpose: a route that validated first would answer 400.
    const anonymous = await server.app.request("/api/search?q=&sources=bogus")
    expect(anonymous.status).toBe(401)
    expect(await json<{ error: { code: string } }>(anonymous)).toMatchObject({
      error: { code: "unauthorized" },
    })
  })

  it("defaults the limit and accepts a query of exactly 200 characters", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const spy = vi.spyOn(server.backend, "search")

    expect((await runSearch(server, cookie, "q=alpha")).status).toBe(200)
    expect(spy.mock.calls[0]?.[0]).toEqual({
      query: "alpha",
      sources: ["chats", "workspace", "web", "apps"],
      limit: 20,
    })

    const long = "a".repeat(200)
    expect((await runSearch(server, cookie, `q=${long}`)).status).toBe(200)
  })

  it("dedupes and trims the source list", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const spy = vi.spyOn(server.backend, "search")

    const response = await runSearch(server, cookie, "q=alpha&sources=%20chats%20,chats")
    expect(response.status).toBe(200)
    const body = await json<SearchResponse>(response)
    expect(body.groups.map((group) => group.source)).toEqual(["chats"])
    expect(spy.mock.calls[0]?.[0].sources).toEqual(["chats"])
  })

  it("dedupes hits by id and clamps a group to the limit", async () => {
    const server = makeServer()
    const cookie = await login(server)
    vi.spyOn(server.backend, "search").mockResolvedValue({
      available: ["chats", "workspace", "web", "apps"],
      failed: [],
      hits: [
        { source: "chats", id: "same", title: "First", sessionID: "ses_1" },
        { source: "chats", id: "same", title: "Duplicate", sessionID: "ses_1" },
        { source: "chats", id: "other", title: "Second", sessionID: "ses_2" },
        { source: "chats", id: "third", title: "Third", sessionID: "ses_3" },
      ],
    })

    const body = await json<SearchResponse>(
      await runSearch(server, cookie, "q=alpha&sources=chats&limit=2"),
    )
    expect(body.groups[0]?.hits.map((hit) => hit.title)).toEqual(["First", "Second"])
    expect(body.groups[0]?.total).toBe(2)
  })

  it("rejects a missing, blank, over-long or unknown request", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const cases = [
      "q=",
      "q=%20%20",
      `q=${"a".repeat(201)}`,
      "q=alpha&sources=bogus",
      "q=alpha&sources=chats,bogus",
      "q=alpha&sources=",
      "q=alpha&limit=0",
      "q=alpha&limit=51",
      "q=alpha&limit=abc",
      "q=alpha&limit=1.5",
    ]

    for (const query of cases) {
      const response = await runSearch(server, cookie, query)
      expect(response.status, query).toBe(400)
      expect(await json<{ error: { code: string } }>(response)).toMatchObject({
        error: { code: "invalid_request" },
      })
    }
  })

  it("groups every source by default and trims the query", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await json<{ id: string }>(
      await server.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "Alpha planning" }),
      }),
    )

    const response = await runSearch(server, cookie, "q=%20alpha%20")
    expect(response.status).toBe(200)
    const body = await json<SearchResponse>(response)

    expect(body.query).toBe("alpha")
    expect(body.available).toEqual(["chats", "workspace", "web", "apps"])
    expect(body.groups.map((group) => group.source)).toEqual([
      "chats",
      "workspace",
      "web",
      "apps",
    ])
    const chats = groupOf(body, "chats")
    expect(chats?.state).toBe("ok")
    expect(chats?.hits).toContainEqual({
      source: "chats",
      id: `chat-${session.id}`,
      title: "Alpha planning",
      sessionID: session.id,
    })
    expect(chats?.total).toBe(chats?.hits.length)
    // No match in the fixed fake data: an empty but successful group.
    expect(groupOf(body, "workspace")).toMatchObject({ state: "ok", total: 0, hits: [] })
  })

  it("queries only the requested sources, in the requested order", async () => {
    const server = makeServer()
    const cookie = await login(server)

    const response = await runSearch(server, cookie, "q=github&sources=apps")
    const body = await json<SearchResponse>(response)

    expect(body.groups.map((group) => group.source)).toEqual(["apps"])
    expect(body.groups[0]?.hits).toContainEqual(
      expect.objectContaining({ source: "apps", app: "github", appKind: "server" }),
    )
    expect(body.available).toEqual(["chats", "workspace", "web", "apps"])
  })

  it("reports an unconfigured source as disabled with no hits", async () => {
    const server = makeServer({ disabledSources: ["web"] })
    const cookie = await login(server)

    const response = await runSearch(server, cookie, "q=opencode")
    const body = await json<SearchResponse>(response)

    expect(body.available).toEqual(["chats", "workspace", "apps"])
    expect(groupOf(body, "web")).toEqual({
      source: "web",
      state: "disabled",
      total: 0,
      hits: [],
    })
    expect(body.groups.flatMap((group) => group.hits).some((hit) => hit.source === "web")).toBe(
      false,
    )
  })

  it("reports a failing source without hiding the others", async () => {
    const server = makeServer({ failingSources: ["workspace"] })
    const cookie = await login(server)

    const body = await json<SearchResponse>(await runSearch(server, cookie, "q=opencode"))

    expect(groupOf(body, "workspace")).toEqual({
      source: "workspace",
      state: "failed",
      total: 0,
      hits: [],
    })
    expect(groupOf(body, "web")?.state).toBe("ok")
    expect(groupOf(body, "web")?.hits.length).toBeGreaterThan(0)
  })

  it("caps each group at the requested limit", async () => {
    const server = makeServer()
    const cookie = await login(server)
    for (const title of ["Alpha one", "Alpha two", "Alpha three"]) {
      await server.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title }),
      })
    }

    const body = await json<SearchResponse>(await runSearch(server, cookie, "q=alpha&limit=2"))

    const chats = groupOf(body, "chats")
    expect(chats?.hits).toHaveLength(2)
    expect(chats?.total).toBe(2)
    // Every other group stays within the cap as well.
    for (const group of body.groups) {
      expect(group.hits.length).toBeLessThanOrEqual(2)
    }
  })
})
