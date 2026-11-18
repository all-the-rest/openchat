import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "../src/api/client"

const fetchMock = vi.fn()

function noContent(): Response {
  return new Response(null, { status: 204 })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(noContent())
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The request the client sent: URL plus the method it used. */
function lastRequest(): { url: string; method: string } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return { url, method: init.method ?? "GET" }
}

describe("apps client", () => {
  it("encodes a server name as one path segment on connect", async () => {
    await api.connectApp("a b")

    expect(lastRequest()).toEqual({ url: "/api/apps/a%20b/connect", method: "POST" })
  })

  it("encodes a server name as one path segment on disconnect", async () => {
    await api.disconnectApp("a b")

    expect(lastRequest()).toEqual({ url: "/api/apps/a%20b/disconnect", method: "POST" })
  })

  it("leaves a host-valid name unchanged", async () => {
    await api.connectApp("github")

    expect(lastRequest()).toEqual({ url: "/api/apps/github/connect", method: "POST" })
  })
})
