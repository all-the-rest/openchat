import { describe, expect, it, vi } from "vitest"
import { BackendError } from "@openchat/opencode"
import type { AppsResponse } from "@openchat/contracts"
import type { AppsSnapshot } from "@openchat/opencode"
import { FixedWindowThrottle } from "../src/throttle"
import { loadEnv } from "../src/env"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const APP_STATUSES = ["connected", "pending", "disabled", "failed", "needs_auth"]

async function getApps(server: TestServer, cookie: string): Promise<Response> {
  return server.app.request("/api/apps", { headers: { cookie } })
}

async function action(
  server: TestServer,
  cookie: string,
  name: string,
  verb: string,
): Promise<Response> {
  return await server.app.request(`/api/apps/${name}/${verb}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "",
  })
}

function statusOf(body: AppsResponse, name: string): string | undefined {
  return body.servers.find((server) => server.name === name)?.status
}

describe("GET /api/apps", () => {
  it("requires a session", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/apps")
    expect(response.status).toBe(401)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "unauthorized" },
    })
  })

  it("lists every status and never the skill body", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await getApps(server, cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")

    const body = await json<AppsResponse>(response)
    expect(body.available).toBe(true)
    expect(new Set(body.servers.map((entry) => entry.status))).toEqual(new Set(APP_STATUSES))
    expect(body.servers).toContainEqual({
      name: "github",
      title: "GitHub",
      status: "needs_auth",
      error: "The OAuth token is missing or expired.",
    })
    expect(statusOf(body, "filesystem")).toBe("connected")
    expect(statusOf(body, "linear")).toBe("pending")
    expect(statusOf(body, "notes")).toBe("disabled")
    expect(body.skills.map((skill) => skill.id)).toEqual(["review", "release"])

    const text = JSON.stringify(body)
    expect(text).not.toContain("SKILL.md")
    expect(text).not.toContain("summary")
  })

  it("answers an empty surface for a host without the capability", async () => {
    const server = makeServer({ env: { FAKE_APPS: "off" } })
    const cookie = await login(server)

    const response = await getApps(server, cookie)
    expect(response.status).toBe(200)
    expect(await json<AppsResponse>(response)).toEqual({
      available: false,
      servers: [],
      skills: [],
    })

    const info = await json<{ apps: { available: boolean } }>(
      await server.app.request("/api/info", { headers: { cookie } }),
    )
    expect(info.apps).toEqual({ available: false })
  })

  it("answers 502 without upstream text when the host fails", async () => {
    const server = makeServer({
      appsProbe: async () => {
        throw new Error("upstream boom secret")
      },
    })
    const cookie = await login(server)
    const response = await getApps(server, cookie)
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: "apps_unavailable" } })
    expect(text).not.toContain("boom")
    expect(text).not.toContain("secret")
  })

  it("caches one upstream read per window", async () => {
    let now = 0
    let calls = 0
    const probe = async (): Promise<AppsSnapshot> => {
      calls += 1
      return { servers: [], skills: [] }
    }
    const server = makeServer({ appsProbe: probe, appsNow: () => now })
    const cookie = await login(server)

    await getApps(server, cookie)
    await getApps(server, cookie)
    expect(calls).toBe(1)

    now = 10_001
    await getApps(server, cookie)
    expect(calls).toBe(2)
  })

  it("shares the snapshot with /api/info", async () => {
    let calls = 0
    let now = 0
    const probe = async (): Promise<AppsSnapshot> => {
      calls += 1
      return { servers: [], skills: [] }
    }
    const server = makeServer({ appsProbe: probe, appsNow: () => now })
    const cookie = await login(server)

    await getApps(server, cookie)
    const info = await json<{ apps: { available: boolean } }>(
      await server.app.request("/api/info", { headers: { cookie } }),
    )
    expect(info.apps).toEqual({ available: true })
    expect(calls).toBe(1)

    now = 10_001
    await server.app.request("/api/info", { headers: { cookie } })
    expect(calls).toBe(2)
  })
})

describe("connect and disconnect", () => {
  it("re-reads the status after each action", async () => {
    const calls: Array<[string, string]> = []
    const server = makeServer({ onAppAction: (verb, name) => calls.push([verb, name]) })
    const cookie = await login(server)

    expect(statusOf(await json<AppsResponse>(await getApps(server, cookie)), "github")).toBe(
      "needs_auth",
    )

    expect((await action(server, cookie, "github", "connect")).status).toBe(204)
    const connected = await json<AppsResponse>(await getApps(server, cookie))
    expect(connected.servers.find((entry) => entry.name === "github")).toEqual({
      name: "github",
      title: "GitHub",
      status: "connected",
    })

    expect((await action(server, cookie, "github", "disconnect")).status).toBe(204)
    expect(statusOf(await json<AppsResponse>(await getApps(server, cookie)), "github")).toBe(
      "pending",
    )
    expect(calls).toEqual([
      ["connect", "github"],
      ["disconnect", "github"],
    ])
  })

  it("answers 404 for a server the snapshot does not know", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await action(server, cookie, "nope", "connect")
    expect(response.status).toBe(404)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "apps_unknown_server" },
    })
  })

  it.each(["%20", "a".repeat(65), "with%2Fslash", "..%2F.."])(
    "answers 404 for the impossible name %j",
    async (name) => {
      const server = makeServer()
      const cookie = await login(server)
      const response = await action(server, cookie, name, "connect")
      expect(response.status).toBe(404)
    },
  )

  it("maps a server that vanished after the snapshot to 404", async () => {
    const server = makeServer()
    vi.spyOn(server.backend, "connectApp").mockRejectedValue(
      new BackendError("not_found", "upstream said the server is gone"),
    )
    const cookie = await login(server)
    const response = await action(server, cookie, "github", "connect")
    expect(response.status).toBe(404)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: "apps_unknown_server" } })
    expect(text).not.toContain("upstream said")
  })

  it("maps a disabled server to 409", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await action(server, cookie, "notes", "connect")
    expect(response.status).toBe(409)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({
      error: {
        code: "apps_disabled",
        message: "The server is disabled in the host configuration",
      },
    })

    // Disconnecting a disabled server is a no-op, not an error.
    expect((await action(server, cookie, "notes", "disconnect")).status).toBe(204)
    expect(statusOf(await json<AppsResponse>(await getApps(server, cookie)), "notes")).toBe(
      "disabled",
    )
  })

  it("maps a rejected name to 400", async () => {
    const server = makeServer()
    vi.spyOn(server.backend, "connectApp").mockRejectedValue(
      new BackendError("invalid", "upstream says no"),
    )
    const cookie = await login(server)
    const response = await action(server, cookie, "github", "connect")
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: "apps_invalid_name" } })
    expect(text).not.toContain("says no")
  })

  it("maps any other rejection to 502 without upstream text", async () => {
    const server = makeServer()
    vi.spyOn(server.backend, "disconnectApp").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:4096"),
    )
    const cookie = await login(server)
    const response = await action(server, cookie, "filesystem", "disconnect")
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: "apps_unavailable" } })
    expect(text).not.toContain("ECONNREFUSED")
  })

  it("rejects a cross-site POST before it reaches the backend", async () => {
    const calls: string[] = []
    const server = makeServer({ onAppAction: (_verb, name) => calls.push(name) })
    const cookie = await login(server)
    const response = await server.app.request("/api/apps/github/connect", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        host: "localhost:8787",
        origin: "http://evil.example",
      },
      body: "",
    })
    expect(response.status).toBe(403)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "cross_origin" },
    })
    expect(calls).toEqual([])
  })

  it("throttles the eleventh action in the window", async () => {
    const throttle = new FixedWindowThrottle({
      limit: 10,
      windowMs: 60_000,
      now: () => 0,
    })
    const server = makeServer({ appsActionThrottle: throttle })
    const cookie = await login(server)

    for (let index = 0; index < 10; index += 1) {
      expect((await action(server, cookie, "github", "connect")).status).toBe(204)
    }
    const limited = await action(server, cookie, "github", "connect")
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
  })
})

describe("/api/info apps availability", () => {
  it("stays 200 when the probe fails", async () => {
    const server = makeServer({
      appsProbe: async () => {
        throw new Error("upstream boom")
      },
    })
    const cookie = await login(server)
    const response = await server.app.request("/api/info", { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = await json<{ apps: { available: boolean } }>(response)
    expect(body.apps).toEqual({ available: false })
  })
})

describe("FAKE_APPS", () => {
  it("parses off and falls back to on for an unknown value", () => {
    const off = loadEnv({ source: { FAKE_APPS: "off" }, warn: () => {} })
    expect(off.FAKE_APPS).toBe(false)

    const upper = loadEnv({ source: { FAKE_APPS: "OFF" }, warn: () => {} })
    expect(upper.FAKE_APPS).toBe(false)

    const on = loadEnv({ source: { FAKE_APPS: "on" }, warn: () => {} })
    expect(on.FAKE_APPS).toBe(true)

    const warnings: string[] = []
    const invalid = loadEnv({
      source: { FAKE_APPS: "sometimes" },
      warn: (message) => warnings.push(message),
    })
    expect(invalid.FAKE_APPS).toBe(true)
    expect(warnings.some((entry) => entry.includes("FAKE_APPS"))).toBe(true)
    expect(warnings.join("\n")).not.toContain("sometimes")
  })
})
