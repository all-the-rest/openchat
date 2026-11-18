import { request as httpRequest } from "node:http"
import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { basicAuthorization } from "../src/http"
import {
  OPENCODE_PASSWORD,
  APP_ORIGIN,
  cookieFor,
  makeApp,
  rawHeaderValues,
  rawRequest,
  startCodeHost,
  startUpstream,
} from "./helpers"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function track<T extends { close(): Promise<void> }>(value: T): T {
  cleanups.push(() => value.close())
  return value
}

describe("authentication gate", () => {
  it("never reaches upstream for an unauthenticated navigation", async () => {
    const upstream = track(
      await startUpstream((_request, response) => {
        response.setHeader("content-type", "text/html")
        response.end("<html>leaked shell</html>")
      }),
    )
    const { app } = makeApp({ OPENCODE_URL: upstream.url })

    const response = await app.request("/", { headers: { accept: "text/html" } })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain("Sign in to Open Code")
    expect(upstream.requests).toHaveLength(0)
  })

  it("rejects an expired or forged session cookie", async () => {
    const { app, config } = makeApp()
    const expired = await app.request("/api/session", {
      headers: { cookie: cookieFor(config, Date.now() - 90_000_000) },
    })
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({ error: "code_session_required" })
  })
})

describe("proxy response", () => {
  it("returns the upstream shell for a valid cookie", async () => {
    const upstream = track(
      await startUpstream((_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8")
        response.end("<html><body>opencode shell</body></html>")
      }),
    )
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })

    const response = await app.request("/", {
      headers: { cookie: cookieFor(config), accept: "text/html" },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("opencode shell")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  })

  it("keeps the upstream CSP byte-identical and appends frame-ancestors", async () => {
    const upstreamPolicy = "default-src 'self'; frame-src 'self' blob:"
    const upstream = track(
      await startUpstream((_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8")
        response.setHeader("content-security-policy", upstreamPolicy)
        response.setHeader("x-frame-options", "DENY")
        response.end("<html>shell</html>")
      }),
    )
    const host = track(await startCodeHost({ OPENCODE_URL: upstream.url }))
    const raw = await rawRequest(host.origin, "/", {
      headers: { cookie: cookieFor(host.config), accept: "text/html" },
    })

    const policies = rawHeaderValues(raw.rawHeaders, "content-security-policy")
    expect(policies).toEqual([upstreamPolicy, `frame-ancestors ${APP_ORIGIN}`])
    expect(raw.headers["x-frame-options"]).toBeUndefined()
  })

  it("injects Basic auth, strips cookies and never echoes credentials or upstream cookies", async () => {
    const upstream = track(
      await startUpstream((request, response) => {
        response.setHeader("content-type", "application/json")
        response.setHeader("set-cookie", "upstream=leak; Path=/")
        response.setHeader("authorization", request.headers.authorization ?? "missing")
        response.end(JSON.stringify({ ok: true }))
      }),
    )
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })

    const response = await app.request("/api/session", {
      headers: { cookie: cookieFor(config), authorization: "Bearer browser-token" },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("authorization")).toBeNull()
    expect(response.headers.getSetCookie()).toEqual([])
    const received = upstream.requests[0]
    expect(received?.headers.authorization).toBe(
      basicAuthorization(config.OPENCODE_USERNAME, OPENCODE_PASSWORD),
    )
    expect(received?.headers.cookie).toBeUndefined()
  })

  it("proxies /api with no-store and keeps query strings", async () => {
    const upstream = track(
      await startUpstream((request, response) => {
        response.setHeader("content-type", "application/json")
        response.setHeader("cache-control", "public, max-age=120")
        response.end(JSON.stringify({ url: request.url }))
      }),
    )
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })

    const response = await app.request("/api/info?verbose=1", {
      headers: { cookie: cookieFor(config) },
    })
    expect(await response.json()).toEqual({ url: "/api/info?verbose=1" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(upstream.requests[0]?.url).toBe("/api/info?verbose=1")
  })

  it("keeps the upstream cache header for content-hashed assets", async () => {
    const upstream = track(
      await startUpstream((_request, response) => {
        response.setHeader("content-type", "text/javascript")
        response.setHeader("cache-control", "public, max-age=31536000, immutable")
        response.end("export const shell = true")
      }),
    )
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })

    const response = await app.request("/assets/index-abc123.js", {
      headers: { cookie: cookieFor(config) },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  })

  it("streams a POST body and query through to upstream", async () => {
    const upstream = track(
      await startUpstream((request, response, body) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ method: request.method, url: request.url, body }))
      }),
    )
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })

    const response = await app.request("/api/echo?x=1", {
      method: "POST",
      headers: { cookie: cookieFor(config), "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      method: "POST",
      url: "/api/echo?x=1",
      body: JSON.stringify({ prompt: "hello" }),
    })
  })

  it("answers 502 without upstream detail when the Code host is down", async () => {
    const { app, config } = makeApp({ OPENCODE_URL: "http://127.0.0.1:1" })
    const response = await app.request("/api/session", {
      headers: { cookie: cookieFor(config) },
    })

    expect(response.status).toBe(502)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ error: "code_host_unavailable" })
    expect(body).not.toContain("ECONNREFUSED")
    expect(body).not.toContain("127.0.0.1")
  })
})

describe("SSE", () => {
  interface OpenStream {
    response: IncomingMessage
    first: Promise<string>
  }

  function openStream(url: string, headers: Record<string, string>): Promise<OpenStream> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(url, { headers }, (response) => {
        const first = new Promise<string>((done, fail) => {
          const timer = setTimeout(() => fail(new Error("No chunk arrived")), 2_000)
          response.once("data", (chunk: Buffer) => {
            clearTimeout(timer)
            done(chunk.toString("utf8"))
          })
        })
        resolve({ response, first })
      })
      request.on("error", reject)
      request.end()
    })
  }

  it("delivers chunk 1 while upstream still holds the response open", async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const upstream = track(
      await startUpstream((_request, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        })
        response.write("data: first\n\n")
        void held.then(() => {
          response.write("data: second\n\n")
          response.end()
        })
      }),
    )
    const host = track(await startCodeHost({ OPENCODE_URL: upstream.url }))
    const { response, first } = await openStream(`${host.origin}/api/events`, {
      cookie: cookieFor(host.config),
    })
    try {
      expect(response.headers["content-type"]).toContain("text/event-stream")
      expect(response.headers["x-accel-buffering"]).toBe("no")
      expect(response.headers["cache-control"]).toContain("no-transform")
      expect(response.headers["cache-control"]).not.toBe("no-store")

      // The upstream write promise has not resolved, so this chunk proves the
      // proxy did not buffer the event stream.
      expect(await first).toContain("data: first")
    } finally {
      release?.()
      response.destroy()
    }
  })
})
