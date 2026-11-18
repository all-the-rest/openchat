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

describe("artifacts client", () => {
  it("reads the list from the BFF", async () => {
    const fixture = [
      {
        id: "a".repeat(64),
        title: "Report",
        bytes: 3,
        createdAt: "2026-11-18T12:00:00.000Z",
        url: `https://artifacts.example.test/a/${"a".repeat(64)}?exp=1&sig=${"s".repeat(43)}`,
        expiresAt: "2026-11-18T12:15:00.000Z",
      },
    ]
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(api.artifacts()).resolves.toEqual(fixture)
    expect(lastRequest()).toEqual({ url: "/api/artifacts", method: "GET" })
  })

  it("reads one artifact by its encoded id", async () => {
    const id = "a".repeat(64)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await api.artifact(id)
    expect(lastRequest()).toEqual({ url: `/api/artifacts/${id}`, method: "GET" })
  })

  it("downloads bytes from the app origin, never the signed host URL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    )

    const blob = await api.artifactDownload("a b")
    expect(lastRequest()).toEqual({ url: "/api/artifacts/a%20b/download", method: "GET" })
    await expect(blob.text()).resolves.toBe("<!doctype html><html></html>")
  })

  it("throws a structured error for a refused download", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "artifacts_unknown", message: "Unknown" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(api.artifactDownload("a".repeat(64))).rejects.toMatchObject({
      status: 404,
      code: "artifacts_unknown",
    })
  })
})

describe("chat file upload client", () => {
  it("sends raw bytes with the name in the query and no JSON content type", async () => {
    const file = {
      name: "report.pdf",
      displayName: "report.pdf",
      size: 4,
      mtime: "2026-11-18T12:00:00.000Z",
      mime: "application/pdf",
      origin: "upload",
      sha256: "a".repeat(64),
    }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(file), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    )

    const bytes = new Blob(["%PDF"], { type: "application/pdf" })
    await expect(api.uploadChatFile("ses_one", "report.pdf", bytes)).resolves.toEqual(file)

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(url).toBe("/api/sessions/ses_one/files?name=report.pdf")
    expect(init.method).toBe("POST")
    expect(init.body).toBe(bytes)
    expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream")
  })

  it("encodes a file name with spaces in the query", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 201 }))
    await api.uploadChatFile("ses_one", "my report.pdf", new Blob(["x"]))
    expect(lastRequest().url).toBe("/api/sessions/ses_one/files?name=my+report.pdf")
  })
})

describe("auth client", () => {
  it("sends the username and password to the login route", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: "owner" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(api.login("owner", "secret")).resolves.toEqual({ user: "owner" })

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(url).toBe("/api/auth/login")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ user: "owner", password: "secret" })
  })
})
