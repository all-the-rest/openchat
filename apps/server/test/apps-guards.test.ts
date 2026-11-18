import { describe, expect, it, vi } from "vitest"
import type { AppsSnapshot } from "@openchat/opencode"
import { AppsCache } from "../src/apps-cache"
import { FixedWindowThrottle } from "../src/throttle"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

interface ErrorBody {
  error: { code: string }
}

/**
 * Every test here pins a control whose deletion would otherwise leave the
 * suite green: the two name guards, the throttle order and the cache's
 * failure handling.
 */

async function getApps(server: TestServer, cookie: string): Promise<Response> {
  return await server.app.request("/api/apps", { headers: { cookie } })
}

async function action(
  server: TestServer,
  cookie: string,
  name: string,
  verb: "connect" | "disconnect",
): Promise<Response> {
  return await server.app.request(`/api/apps/${name}/${verb}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "",
  })
}

describe("app action guards", () => {
  it("never reaches the host for a name absent from the snapshot", async () => {
    const server = makeServer()
    // The stubs would succeed if the guard let them through, so a 204 would
    // prove the guard is gone.
    const connect = vi.spyOn(server.backend, "connectApp").mockResolvedValue(undefined)
    const disconnect = vi.spyOn(server.backend, "disconnectApp").mockResolvedValue(undefined)
    const cookie = await login(server)

    for (const verb of ["connect", "disconnect"] as const) {
      const response = await action(server, cookie, "nope", verb)
      expect(response.status).toBe(404)
      expect(await json<ErrorBody>(response)).toMatchObject({
        error: { code: "apps_unknown_server" },
      })
    }
    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it("acts on a listed name with a space or non-ASCII characters", async () => {
    // A host may report these names; the presence check is the authorization,
    // so they must be actionable instead of permanently 404.
    const server = makeServer({
      appsProbe: async (): Promise<AppsSnapshot> => ({
        servers: [
          { name: "git hub", status: "needs_auth" },
          { name: "Über-Server", status: "pending" },
        ],
        skills: [],
      }),
    })
    const connect = vi.spyOn(server.backend, "connectApp").mockResolvedValue(undefined)
    const disconnect = vi.spyOn(server.backend, "disconnectApp").mockResolvedValue(undefined)
    const cookie = await login(server)

    const spaced = await action(server, cookie, encodeURIComponent("git hub"), "connect")
    expect(spaced.status).toBe(204)
    expect(connect).toHaveBeenCalledWith("git hub")

    const umlaut = await action(server, cookie, encodeURIComponent("Über-Server"), "disconnect")
    expect(umlaut.status).toBe(204)
    expect(disconnect).toHaveBeenCalledWith("Über-Server")
  })

  it("refuses a separator or control character before reading the snapshot", async () => {
    let probes = 0
    const server = makeServer({
      appsProbe: async (): Promise<AppsSnapshot> => {
        probes += 1
        return { servers: [{ name: "git hub", status: "connected" }], skills: [] }
      },
    })
    const connect = vi.spyOn(server.backend, "connectApp").mockResolvedValue(undefined)
    const cookie = await login(server)

    const refused = [
      "nul%00byte",
      "with%2Fslash",
      "back%5Cslash",
      "query%3Fmark",
      "hash%23mark",
      "a".repeat(129),
    ]
    for (const name of refused) {
      const response = await action(server, cookie, name, "connect")
      expect(response.status, name).toBe(404)
      // A router-level 404 would be plain text; this body proves the handler ran.
      expect(await json<ErrorBody>(response)).toMatchObject({
        error: { code: "apps_unknown_server" },
      })
    }
    expect(connect).not.toHaveBeenCalled()
    // Every refusal happens before the snapshot read.
    expect(probes).toBe(0)
  })

  it("accepts a name at the length limit and refuses one character more", async () => {
    const longest = "a".repeat(128)
    const tooLong = "a".repeat(129)
    // Both names are listed, so only the length check keeps the longer one from
    // reaching the host.
    const server = makeServer({
      appsProbe: async (): Promise<AppsSnapshot> => ({
        servers: [
          { name: longest, status: "connected" },
          { name: tooLong, status: "connected" },
        ],
        skills: [],
      }),
    })
    const connect = vi.spyOn(server.backend, "connectApp").mockResolvedValue(undefined)
    const cookie = await login(server)

    expect((await action(server, cookie, longest, "connect")).status).toBe(204)
    expect(connect).toHaveBeenCalledWith(longest)

    expect((await action(server, cookie, tooLong, "connect")).status).toBe(404)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("charges a refused attempt to the action budget", async () => {
    const throttle = new FixedWindowThrottle({ limit: 10, windowMs: 60_000, now: () => 0 })
    const server = makeServer({ appsActionThrottle: throttle })
    const cookie = await login(server)

    for (let index = 0; index < 10; index += 1) {
      expect((await action(server, cookie, "nope", "connect")).status).toBe(404)
    }
    // A successful name is still refused: the ten failed attempts consumed
    // the window, which only holds when `record` runs before the guards.
    const limited = await action(server, cookie, "github", "connect")
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    expect(await json<ErrorBody>(limited)).toMatchObject({
      error: { code: "too_many_requests" },
    })
  })

  it("answers 502 for an action on a host without the surface", async () => {
    const server = makeServer({ env: { FAKE_APPS: "off" } })
    const cookie = await login(server)

    const response = await action(server, cookie, "github", "connect")
    expect(response.status).toBe(502)
    expect(await json<ErrorBody>(response)).toMatchObject({
      error: { code: "apps_unavailable" },
    })
  })
})

describe("app snapshot cache", () => {
  it("does not cache a failed probe", async () => {
    let calls = 0
    const probe = async (): Promise<AppsSnapshot> => {
      calls += 1
      if (calls === 1) throw new Error("upstream down")
      return { servers: [{ name: "filesystem", status: "connected" }], skills: [] }
    }
    // Frozen clock: both reads fall into the same 10 s window.
    const server = makeServer({ appsProbe: probe, appsNow: () => 0 })
    const cookie = await login(server)

    expect((await getApps(server, cookie)).status).toBe(502)
    const second = await getApps(server, cookie)
    expect(second.status).toBe(200)
    expect(calls).toBe(2)
  })

  it("probes once when two readers arrive together", async () => {
    let calls = 0
    let release: (snapshot: AppsSnapshot) => void = () => {}
    const probe = async (): Promise<AppsSnapshot> => {
      calls += 1
      return await new Promise<AppsSnapshot>((resolve) => {
        release = resolve
      })
    }
    const cache = new AppsCache({ probe, now: () => 0 })

    const first = cache.get()
    const second = cache.get()
    // The probe runs synchronously up to its first await, so no response has
    // arrived yet and the second reader must have joined the first request.
    expect(calls).toBe(1)

    release({ servers: [], skills: [] })
    expect(await first).toEqual({ available: true, servers: [], skills: [] })
    expect(await second).toEqual({ available: true, servers: [], skills: [] })
    expect(calls).toBe(1)
  })
})
