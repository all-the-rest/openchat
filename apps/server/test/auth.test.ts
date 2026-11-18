import { describe, expect, it } from "vitest"
import { basicHeader, json, login, makeServer, makeConfig } from "./helpers"
import { SERVER_VERSION, createApp } from "../src/app"
import { FakeBackend } from "@openchat/opencode"

describe("healthz", () => {
  it("is public", async () => {
    const server = makeServer()
    const response = await server.app.request("/healthz")
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      ok: true,
      mode: "fake",
      version: SERVER_VERSION,
    })
  })
})

describe("session auth", () => {
  it("logs in and issues a hardened cookie", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "owner", password: "secret-password" }),
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

  it("uses the __Host- name with Secure when COOKIE_SECURE=1", async () => {
    const server = makeServer({ env: { COOKIE_SECURE: "1" } })
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "owner", password: "secret-password" }),
    })
    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie.startsWith("__Host-oc_session=")).toBe(true)
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("Path=/")
    expect(cookie).not.toContain("Domain")
  })

  it("ignores a stale unprefixed cookie when Secure is on", async () => {
    const server = makeServer({ env: { COOKIE_SECURE: "1" } })
    const cookie = await login(server)
    expect(cookie.startsWith("__Host-oc_session=")).toBe(true)

    // An older release or a sibling subdomain could plant this name; only the
    // active `__Host-` name may authenticate.
    const stale = cookie.replace("__Host-oc_session=", "oc_session=")
    const rejected = await server.app.request("/api/auth/me", {
      headers: { cookie: stale },
    })
    expect(rejected.status).toBe(401)

    const accepted = await server.app.request("/api/auth/me", { headers: { cookie } })
    expect(accepted.status).toBe(200)
    expect(await json(accepted)).toEqual({ user: "owner" })
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
      body: JSON.stringify({ user: "owner", password: "wrong" }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await json(response)).toEqual({
      error: { code: "invalid_credentials", message: "Invalid user or password" },
    })
  })

  it("rejects a wrong user even with the right password", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "admin", password: "secret-password" }),
    })
    expect(response.status).toBe(401)
    expect(await json(response)).toEqual({
      error: { code: "invalid_credentials", message: "Invalid user or password" },
    })
  })

  it("rejects a login body without a user", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret-password" }),
    })
    expect(response.status).toBe(400)
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

  it("clears the active __Host- name on a Secure deployment", async () => {
    const server = makeServer({ env: { COOKIE_SECURE: "1" } })
    const cookie = await login(server)
    const response = await server.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    })
    expect(response.status).toBe(204)
    const cleared = response.headers.get("set-cookie") ?? ""
    expect(cleared.startsWith("__Host-oc_session=;")).toBe(true)
    expect(cleared).toContain("Secure")
    expect(cleared).not.toContain("Domain")
  })
})

/**
 * bcrypt test vector: cost 4 (kept low so the suite stays fast), password
 * `secret-password`. The `$2a$` prefix is what the predecessor stack's hash
 * uses; `$2b$` and `$2y$` are accepted too and must verify identically.
 */
const PASSWORD_HASH = "$2a$04$Yq4Me9RVGpnS4XyTf0tQPuN/p6CYrC22mxsDjzEp9Tpg3m6Qrlbpq"

describe("bcrypt password hash", () => {
  function hashServer(variant = "2a") {
    return makeServer({
      env: {
        OPENCHAT_PASSWORD: undefined,
        OPENCHAT_PASSWORD_HASH: PASSWORD_HASH.replace("$2a$", `$${variant}$`),
      },
    })
  }

  it.each(["2a", "2b", "2y"])("logs in with a $%s$ hash and no plaintext", async (variant) => {
    const server = hashServer(variant)
    expect(server.config.OPENCHAT_PASSWORD).toBe("")
    const cookie = await login(server)
    const me = await server.app.request("/api/auth/me", { headers: { cookie } })
    expect(await json(me)).toEqual({ user: "owner" })
  })

  it("rejects a wrong password and a wrong user with the same answer", async () => {
    const server = hashServer()
    for (const body of [
      { user: "owner", password: "wrong" },
      { user: "admin", password: "secret-password" },
    ]) {
      const response = await server.app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(401)
      expect(await json(response)).toEqual({
        error: { code: "invalid_credentials", message: "Invalid user or password" },
      })
    }
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
