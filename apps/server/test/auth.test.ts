import { describe, expect, it } from "vitest"
import { basicHeader, json, login, makeServer, makeConfig } from "./helpers"
import { createApp } from "../src/app"
import { FakeBackend } from "@openchat/opencode"

describe("healthz", () => {
  it("is public", async () => {
    const server = makeServer()
    const response = await server.app.request("/healthz")
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      ok: true,
      mode: "fake",
      version: "0.1.0",
    })
  })
})

describe("session auth", () => {
  it("logs in and issues a hardened cookie", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret-password" }),
    })

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ user: "owner" })

    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("oc_session=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=3600")
    expect(cookie).not.toContain("Secure")
  })

  it("marks the cookie Secure when COOKIE_SECURE=1", async () => {
    const server = makeServer({ env: { COOKIE_SECURE: "1" } })
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret-password" }),
    })
    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("Secure")
  })

  it("returns the user for a valid cookie and 401 without one", async () => {
    const server = makeServer()
    const cookie = await login(server)

    const me = await server.app.request("/api/auth/me", { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(await json(me)).toEqual({ user: "owner" })

    const anonymous = await server.app.request("/api/auth/me")
    expect(anonymous.status).toBe(401)
    expect(await json(anonymous)).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    })
  })

  it("rejects a wrong password", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await json(response)).toEqual({
      error: { code: "invalid_credentials", message: "Invalid password" },
    })
  })

  it("rejects a tampered cookie", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const tampered = `${cookie}x`
    const response = await server.app.request("/api/auth/me", {
      headers: { cookie: tampered },
    })
    expect(response.status).toBe(401)
  })

  it("clears the cookie on logout", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    })
    expect(response.status).toBe(204)
    const cleared = response.headers.get("set-cookie") ?? ""
    expect(cleared).toContain("oc_session=;")
    expect(cleared).toContain("Max-Age=0")
  })
})

describe("basic auth mode", () => {
  it("accepts the Authorization header and rejects its absence", async () => {
    const config = makeConfig({ AUTH_MODE: "basic" })
    const app = createApp({
      config,
      backend: new FakeBackend({ delayMs: 0, workspace: config.WORKSPACE_DIR }),
    })

    const authorized = await app.request("/api/auth/me", {
      headers: { authorization: basicHeader() },
    })
    expect(authorized.status).toBe(200)
    expect(await json(authorized)).toEqual({ user: "owner" })

    const anonymous = await app.request("/api/auth/me")
    expect(anonymous.status).toBe(401)

    const wrong = await app.request("/api/auth/me", {
      headers: { authorization: basicHeader("owner", "wrong") },
    })
    expect(wrong.status).toBe(401)
  })

  it("does not accept a cookie instead of the header", async () => {
    const sessionServer = makeServer()
    const cookie = await login(sessionServer)

    const config = makeConfig({ AUTH_MODE: "basic" })
    const app = createApp({
      config,
      backend: new FakeBackend({ delayMs: 0, workspace: config.WORKSPACE_DIR }),
    })
    const response = await app.request("/api/auth/me", { headers: { cookie } })
    expect(response.status).toBe(401)
  })
})
