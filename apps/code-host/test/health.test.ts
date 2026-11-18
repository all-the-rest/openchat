import { describe, expect, it } from "vitest"
import { basicAuthorization } from "../src/http"
import { OPENCODE_PASSWORD, makeApp, startUpstream } from "./helpers"

describe("GET /__health", () => {
  it("reports the upstream version without a session cookie", async () => {
    const upstream = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          version: "2.3.0",
          authorization: request.headers.authorization ?? "missing",
        }),
      )
    })
    try {
      const { app, config } = makeApp({ OPENCODE_URL: upstream.url })
      const response = await app.request("/__health")

      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({ ok: true, version: "2.3.0" })
      expect(upstream.requests[0]?.headers.authorization).toBe(
        basicAuthorization(config.OPENCODE_USERNAME, OPENCODE_PASSWORD),
      )
      expect(upstream.requests[0]?.url).toBe("/api/info")
    } finally {
      await upstream.close()
    }
  })

  it("answers 502 when upstream rejects the Basic credential", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.statusCode = 401
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: "unauthorized", detail: "wrong password" }))
    })
    try {
      const { app } = makeApp({ OPENCODE_URL: upstream.url })
      const response = await app.request("/__health")

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ ok: false })
    } finally {
      await upstream.close()
    }
  })

  it("answers 502 when the upstream payload has no version", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ unexpected: true }))
    })
    try {
      const { app } = makeApp({ OPENCODE_URL: upstream.url })
      const response = await app.request("/__health")
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ ok: false })
    } finally {
      await upstream.close()
    }
  })

  it("answers 502 without upstream text when the Code host is unreachable", async () => {
    const { app, logs } = makeApp({ OPENCODE_URL: "http://127.0.0.1:1" })
    const response = await app.request("/__health")

    expect(response.status).toBe(502)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ ok: false })
    expect(body).not.toContain("ECONNREFUSED")
    expect(logs.join("\n")).not.toContain(OPENCODE_PASSWORD)
  })

  it("times out a hanging upstream instead of holding the probe open", async () => {
    const upstream = await startUpstream(() => {
      // Never answer: the probe must abort on its own deadline.
    })
    try {
      const { app } = makeApp({ OPENCODE_URL: upstream.url }, { healthTimeoutMs: 25 })
      const response = await app.request("/__health")
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ ok: false })
    } finally {
      await upstream.close()
    }
  })
})
