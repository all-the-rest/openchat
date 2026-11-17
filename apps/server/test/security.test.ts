import { describe, expect, it } from "vitest"
import { basicHeader, json, login, makeConfig, makeServer } from "./helpers"
import { createApp } from "../src/app"
import { FakeBackend } from "@openchat/opencode"

const PASSWORD = "secret-password"

function loginRequest(headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password: PASSWORD }),
  }
}

function badLoginRequest(headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password: "wrong" }),
  }
}

describe("CSRF guard", () => {
  it("rejects a cross-origin login", async () => {
    const server = makeServer()
    const response = await server.app.request(
      "/api/auth/login",
      loginRequest({ origin: "http://evil.example", host: "localhost:8787" }),
    )
    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({ error: { code: "cross_origin" } })
  })

  it("accepts a same-origin login even when the scheme differs (dev proxy)", async () => {
    const server = makeServer()
    const same = await server.app.request(
      "/api/auth/login",
      loginRequest({ origin: "http://localhost:8787", host: "localhost:8787" }),
    )
    expect(same.status).toBe(200)

    const proxied = await server.app.request(
      "/api/auth/login",
      loginRequest({ origin: "https://localhost:8787", host: "localhost:8787" }),
    )
    expect(proxied.status).toBe(200)
  })

  it("rejects an explicit cross-site fetch", async () => {
    const server = makeServer()
    const response = await server.app.request(
      "/api/auth/login",
      loginRequest({ host: "localhost:8787", "sec-fetch-site": "cross-site" }),
    )
    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({ error: { code: "cross_origin" } })

    const sameOrigin = await server.app.request(
      "/api/auth/login",
      loginRequest({ host: "localhost:8787", "sec-fetch-site": "same-origin" }),
    )
    expect(sameOrigin.status).toBe(200)
  })

  it("protects authenticated state-changing routes too", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/sessions", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://evil.example",
        host: "localhost:8787",
      },
      body: "{}",
    })
    expect(response.status).toBe(403)
  })

  it("allows curl-style requests without Origin or Fetch metadata", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", loginRequest())
    expect(response.status).toBe(200)
  })
})

describe("content type guard", () => {
  it("rejects a text/plain JSON endpoint", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(response.status).toBe(415)
    expect(await json(response)).toMatchObject({ error: { code: "unsupported_media_type" } })
  })

  it("rejects a text/plain session creation", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/sessions", {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: "{}",
    })
    expect(response.status).toBe(415)
  })

  it("exempts logout from the JSON requirement", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    })
    expect(response.status).toBe(204)
  })
})

describe("body cap", () => {
  it("rejects a declared oversized body before authentication", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(200_000),
      },
      body: "{}",
    })
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: "payload_too_large" } })
  })

  it("rejects an actually oversized login body before parsing", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(140 * 1024) }),
    })
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: "payload_too_large" } })
  })
})

describe("login throttle", () => {
  it("answers the 11th failed attempt with 429 and Retry-After", async () => {
    const server = makeServer()
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await server.app.request("/api/auth/login", badLoginRequest())
      expect(response.status).toBe(401)
    }

    const blocked = await server.app.request("/api/auth/login", badLoginRequest())
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await json(blocked)).toMatchObject({ error: { code: "too_many_requests" } })
  })

  it("resets the counter after a successful login", async () => {
    const server = makeServer()
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const response = await server.app.request("/api/auth/login", badLoginRequest())
      expect(response.status).toBe(401)
    }

    const success = await server.app.request("/api/auth/login", loginRequest())
    expect(success.status).toBe(200)

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const response = await server.app.request("/api/auth/login", badLoginRequest())
      expect(response.status).toBe(401)
    }

    const stillAllowed = await server.app.request("/api/auth/login", badLoginRequest())
    expect(stillAllowed.status).toBe(401)

    const blocked = await server.app.request("/api/auth/login", badLoginRequest())
    expect(blocked.status).toBe(429)
  })

  it("counts attempts per trusted client address", async () => {
    const server = makeServer({ env: { TRUST_PROXY: "1" } })
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await server.app.request("/api/auth/login", badLoginRequest())
      expect(response.status).toBe(401)
    }
    const other = await server.app.request(
      "/api/auth/login",
      badLoginRequest({ "x-forwarded-for": "203.0.113.7" }),
    )
    expect(other.status).toBe(401)
  })

  it("ignores a spoofed forwarding header without TRUST_PROXY", async () => {
    const server = makeServer()
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await server.app.request("/api/auth/login", badLoginRequest())
      expect(response.status).toBe(401)
    }
    // The attacker rotates X-Forwarded-For but the bucket is keyed by the
    // socket address, so the next attempt is still blocked.
    const spoofed = await server.app.request(
      "/api/auth/login",
      badLoginRequest({ "x-forwarded-for": "203.0.113.99", "x-real-ip": "203.0.113.98" }),
    )
    expect(spoofed.status).toBe(429)
    expect(Number(spoofed.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("honours X-Real-IP with TRUST_PROXY", async () => {
    const server = makeServer({ env: { TRUST_PROXY: "1" } })
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await server.app.request("/api/auth/login", badLoginRequest())
      expect(response.status).toBe(401)
    }
    const other = await server.app.request(
      "/api/auth/login",
      badLoginRequest({ "x-real-ip": "198.51.100.4" }),
    )
    expect(other.status).toBe(401)
  })
})

describe("basic auth challenge", () => {
  it("adds WWW-Authenticate to a 401", async () => {
    const config = makeConfig({ AUTH_MODE: "basic" })
    const app = createApp({
      config,
      backend: new FakeBackend({ delayMs: 0, workspace: config.WORKSPACE_DIR }),
    })

    const missing = await app.request("/api/auth/me")
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toBe('Basic realm="OpenChat"')

    const wrong = await app.request("/api/auth/me", {
      headers: { authorization: basicHeader("owner", "wrong") },
    })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get("www-authenticate")).toContain('Basic realm="OpenChat"')

    const accepted = await app.request("/api/auth/me", {
      headers: { authorization: basicHeader() },
    })
    expect(accepted.status).toBe(200)
  })
})
