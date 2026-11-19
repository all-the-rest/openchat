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

  it("passes a different upstream major through verbatim", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ version: "3.0.0" }))
    })
    try {
      const { app } = makeApp({ OPENCODE_URL: upstream.url })
      const response = await app.request("/__health")

      expect(response.status).toBe(200)
      // The Code host passes the real upstream major through; the BFF's
      // /api/code/status turns it into `matches: false` and the Code surface
      // warns (pinned in code.test.ts and code-page.test.tsx).
      expect(await response.json()).toEqual({ ok: true, version: "3.0.0" })
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

  it("serves two hits inside five seconds from one upstream probe", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ version: "2.3.0" }))
    })
    try {
      let clock = 1_000
      const { app } = makeApp({ OPENCODE_URL: upstream.url }, { now: () => clock })
      expect((await app.request("/__health")).status).toBe(200)
      clock += 4_999
      expect((await app.request("/__health")).status).toBe(200)
      expect(upstream.requests).toHaveLength(1)

      clock += 1
      expect((await app.request("/__health")).status).toBe(200)
      expect(upstream.requests).toHaveLength(2)
    } finally {
      await upstream.close()
    }
  })

  it("caches a failure too, so a down host is probed once per window", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.statusCode = 401
      response.end()
    })
    try {
      let clock = 1_000
      const { app } = makeApp({ OPENCODE_URL: upstream.url }, { now: () => clock })
      expect((await app.request("/__health")).status).toBe(502)
      clock += 1_000
      expect((await app.request("/__health")).status).toBe(502)
      expect(upstream.requests).toHaveLength(1)
    } finally {
      await upstream.close()
    }
  })

  it("truncates a long version and strips non-printable bytes", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ version: `\u0000\u0007${"2.3.0-"}${"x".repeat(200)}` }))
    })
    try {
      const { app } = makeApp({ OPENCODE_URL: upstream.url })
      const body = (await (await app.request("/__health")).json()) as {
        ok: boolean
        version: string
      }
      expect(body.ok).toBe(true)
      expect(body.version.length).toBe(64)
      expect(body.version.startsWith("2.3.0-")).toBe(true)
    } finally {
      await upstream.close()
    }
  })

  it("does not read an unbounded health body", async () => {
    let pulls = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1_024).fill(0x20))
      },
    })
    const { app } = makeApp(
      {},
      {
        fetchImpl: (async () =>
          new Response(endless, {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      },
    )

    const response = await app.request("/__health")
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ ok: false })
    expect(pulls).toBeLessThan(10)
  })
})
