import { afterEach, describe, expect, it } from "vitest"
import { clientAddress } from "../src/http"
import { createSessionValue } from "../src/session"
import { CODE_HOST_ORIGIN, cookieFor, makeApp, startUpstream } from "./helpers"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function stubUpstream() {
  const upstream = await startUpstream((request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ method: request.method, url: request.url }))
  })
  cleanups.push(() => upstream.close())
  return upstream
}

const GATED_PATHS = ["/", "/assets/x.js", "/api/x", "/session/1", "/__auth/x"]
const METHODS = ["GET", "HEAD", "POST", "OPTIONS"]
const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

describe("authentication gate boundary", () => {
  it("gates every path and method with zero upstream requests", async () => {
    const upstream = await stubUpstream()
    const { app } = makeApp({ OPENCODE_URL: upstream.url })

    for (const path of GATED_PATHS) {
      for (const method of METHODS) {
        // No cookie and no origin evidence: the shape of a bare server-side
        // client, so the cookie check is what answers.
        const response = await app.request(path, { method })
        expect(response.status, `${method} ${path}`).toBe(401)
        expect(
          response.headers.get("cache-control"),
          `${method} ${path}`,
        ).toBe("no-store")
      }
    }
    expect(upstream.requests).toHaveLength(0)
  })

  it("rejects an expired or forged session cookie without asking upstream", async () => {
    const upstream = await stubUpstream()
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })
    const expired = await app.request("/api/session", {
      headers: { cookie: cookieFor(config, Date.now() - 90_000_000) },
    })
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({ error: "code_session_required" })
    expect(upstream.requests).toHaveLength(0)
  })

  it("holds the sign-in page off the HTML-accept shortcut for /api/*", async () => {
    const { app } = makeApp()
    const response = await app.request("/api/x", {
      headers: { accept: "text/html" },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({ error: "code_session_required" })
  })

  it("leaves /__health as the only unauthenticated reach into upstream", async () => {
    const upstream = await stubUpstream()
    const { app } = makeApp({ OPENCODE_URL: upstream.url })

    const health = await app.request("/__health")
    // The stub has no `version`, so the probe answers 502 — reach is what
    // matters here, and the health test covers the payload.
    expect(health.status).toBe(502)
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.url).toBe("/api/info")
  })
})

describe("CSRF origin check on the gate", () => {
  it("rejects every unsafe method with cross-site evidence before upstream", async () => {
    const upstream = await stubUpstream()
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })
    const cookie = cookieFor(config)

    for (const method of UNSAFE_METHODS) {
      const evidence: Array<Record<string, string>> = [
        { "sec-fetch-site": "same-site" },
        { "sec-fetch-site": "cross-site" },
        { origin: "https://artifacts.example.com" },
      ]
      for (const headers of evidence) {
        const response = await app.request("/api/x", {
          method,
          headers: { cookie, ...headers },
        })
        const label = `${method} ${JSON.stringify(headers)}`
        expect(response.status, label).toBe(403)
        expect(response.headers.get("cache-control"), label).toBe("no-store")
        expect(await response.json(), label).toEqual({ error: "cross_origin_forbidden" })
      }
    }
    expect(upstream.requests).toHaveLength(0)
  })

  it("proxies an unsafe method with same-origin evidence or none at all", async () => {
    const upstream = await stubUpstream()
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })
    const cookie = cookieFor(config)

    const cases: Array<Record<string, string>> = [
      { origin: CODE_HOST_ORIGIN },
      { "sec-fetch-site": "same-origin" },
      { origin: CODE_HOST_ORIGIN, "sec-fetch-site": "same-origin" },
      {},
    ]
    for (const headers of cases) {
      const response = await app.request("/api/x", {
        method: "POST",
        headers: { cookie, ...headers },
      })
      expect(response.status, JSON.stringify(headers)).toBe(200)
    }
    expect(upstream.requests).toHaveLength(cases.length)
  })

  it("leaves reads alone even with a cross-site fetch site", async () => {
    const upstream = await stubUpstream()
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })

    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const response = await app.request("/api/x", {
        method,
        headers: { cookie: cookieFor(config), "sec-fetch-site": "cross-site" },
      })
      expect(response.status, method).toBe(200)
    }
    expect(upstream.requests).toHaveLength(3)
  })

  it("logs a rejection with attribution only", async () => {
    const upstream = await stubUpstream()
    const { app, config, logs } = makeApp({ OPENCODE_URL: upstream.url })
    const cookie = cookieFor(config)

    await app.request("/api/x", {
      method: "POST",
      headers: { cookie, origin: "https://artifacts.example.com" },
    })

    const text = logs.join("\n")
    expect(text).toContain("cross-origin request rejected")
    expect(text).not.toContain("artifacts.example.com")
    expect(text).not.toContain(cookie.slice("oc_code=".length))
  })
})

describe("client attribution", () => {
  function request(headers: Record<string, string>): Request {
    return new Request("http://code.test/", { headers })
  }

  it("restricts a forwarded address to a host/address charset", () => {
    expect(
      clientAddress(request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), "127.0.0.1", true),
    ).toBe("203.0.113.7")
    expect(clientAddress(request({ "x-real-ip": "2001:db8::1" }), undefined, true)).toBe(
      "2001:db8::1",
    )
    expect(clientAddress(request({ "x-forwarded-for": "forge me Admin" }), "127.0.0.1", true)).toBe(
      "unknown",
    )
    expect(clientAddress(request({ "x-real-ip": "<script>" }), "127.0.0.1", true)).toBe("unknown")
  })

  it("keeps the socket peer when the proxy header is not trusted", () => {
    expect(clientAddress(request({ "x-forwarded-for": "198.51.100.4" }), "127.0.0.1", false)).toBe(
      "127.0.0.1",
    )
    expect(clientAddress(request({}), undefined, true)).toBe("local")
  })
})

describe("session cookie name", () => {
  it("accepts only the plain name when the cookie is not Secure", async () => {
    const upstream = await stubUpstream()
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url })
    const settings = {
      secret: config.CODE_TICKET_SECRET,
      ttlSeconds: config.CODE_SESSION_TTL_SECONDS,
      secureCookie: false,
    }
    const value = createSessionValue(settings, "owner")

    const plain = await app.request("/api/x", { headers: { cookie: `oc_code=${value}` } })
    expect(plain.status).toBe(200)
    const prefixed = await app.request("/api/x", {
      headers: { cookie: `__Host-oc_code=${value}` },
    })
    expect(prefixed.status).toBe(401)
  })

  it("accepts only __Host- when Secure, so a sibling namespace cannot shadow it", async () => {
    const upstream = await stubUpstream()
    const { app, config } = makeApp({ OPENCODE_URL: upstream.url, COOKIE_SECURE: "1" })
    const settings = {
      secret: config.CODE_TICKET_SECRET,
      ttlSeconds: config.CODE_SESSION_TTL_SECONDS,
      secureCookie: true,
    }
    const value = createSessionValue(settings, "owner")

    const plainOnly = await app.request("/api/x", {
      headers: { cookie: `oc_code=${value}` },
    })
    expect(plainOnly.status).toBe(401)

    // A plain duplicate next to the real cookie is ignored, not merged.
    const shadowed = await app.request("/api/x", {
      headers: { cookie: `oc_code=forged; __Host-oc_code=${value}` },
    })
    expect(shadowed.status).toBe(200)
  })
})
