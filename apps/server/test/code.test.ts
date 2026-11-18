import { afterEach, describe, expect, it, vi } from "vitest"
import { readTicket } from "@openchat/code-ticket"
import type { CodeStatusResponse, CodeTicketResponse } from "@openchat/contracts"
import { SUPPORTED_OPENCODE_MAJOR_LABEL } from "@openchat/opencode"
import { createCodeProbe, safeNext } from "../src/code"
import { FixedWindowThrottle } from "../src/throttle"
import { json, login, makeConfig, makeServer } from "./helpers"

const ORIGIN = "http://code.example:8090"
const SECRET = "test-code-ticket-secret"
const HOST_VERSION = "2.3.0"

function codeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    CODE_HOST_ORIGIN: ORIGIN,
    CODE_TICKET_SECRET: SECRET,
    CODE_TICKET_TTL_SECONDS: "30",
    CODE_STATUS_TIMEOUT_MS: "100",
    ...overrides,
  }
}

function mint(server: ReturnType<typeof makeServer>, cookie: string, next?: string) {
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`
  return server.app.request(`/api/code/ticket${query}`, { headers: { cookie } })
}

function decodeClaims(token: string): { sub: string; exp: number; jti: string; codeHost: string } {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    sub: string
    exp: number
    jti: string
    codeHost: string
  }
}

async function mintedUrl(
  server: ReturnType<typeof makeServer>,
  cookie: string,
  next?: string,
): Promise<URL> {
  const response = await mint(server, cookie, next)
  expect(response.status).toBe(200)
  const body = await json<CodeTicketResponse>(response)
  return new URL(body.url)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("code routes auth", () => {
  it("requires a session for the ticket", async () => {
    const server = makeServer({ env: codeEnv() })
    const response = await server.app.request("/api/code/ticket")
    expect(response.status).toBe(401)
  })

  it("requires a session for the status", async () => {
    const server = makeServer({ env: codeEnv() })
    const response = await server.app.request("/api/code/status")
    expect(response.status).toBe(401)
  })
})

describe("unconfigured Code surface", () => {
  it("answers 404 for a ticket and mints nothing", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await mint(server, cookie)
    expect(response.status).toBe(404)
    expect(await json(response)).toEqual({ error: "code_not_configured" })
  })

  it("reports the status as disabled without probing", async () => {
    const probe = vi.fn(async () => ({ reachable: true, version: HOST_VERSION }))
    const server = makeServer({ codeProbe: probe })
    const cookie = await login(server)
    const response = await server.app.request("/api/code/status", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await json<CodeStatusResponse>(response)).toEqual({
      configured: false,
      reachable: false,
      expectedVersion: SUPPORTED_OPENCODE_MAJOR_LABEL,
      matches: false,
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it("reports it in /api/info so the UI can hide the switch", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/info", { headers: { cookie } })
    const body = await json<{ code: { configured: boolean; expectedVersion: string } }>(response)
    expect(body.code).toEqual({ configured: false, expectedVersion: SUPPORTED_OPENCODE_MAJOR_LABEL })
  })
})

describe("ticket minting", () => {
  it("returns an absolute entry URL with a verifiable single-use ticket", async () => {
    const server = makeServer({ env: codeEnv() })
    const cookie = await login(server)
    const response = await mint(server, cookie, "/workspace/x")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await json<CodeTicketResponse>(response)
    expect(body.url.startsWith(`${ORIGIN}/__auth?ticket=`)).toBe(true)
    expect(body.url).toContain("&next=%2Fworkspace%2Fx")

    const url = new URL(body.url)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe("/__auth")
    expect(url.searchParams.get("next")).toBe("/workspace/x")

    const token = url.searchParams.get("ticket") ?? ""
    const claims = readTicket(token, { secret: SECRET, codeHost: ORIGIN })
    expect(claims).not.toBeNull()
    expect(claims?.sub).toBe("owner")
    const remaining = (claims?.exp ?? 0) - Math.floor(Date.now() / 1000)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(30)
  })

  it("percent-encodes a next path with reserved characters", async () => {
    const server = makeServer({ env: codeEnv() })
    const cookie = await login(server)
    const url = await mintedUrl(server, cookie, "/session/1?tab=a&b=c")
    expect(url.searchParams.get("next")).toBe("/session/1?tab=a&b=c")
  })

  it.each([
    ["/workspace/x", "/workspace/x"],
    ["//evil.example", "/"],
    ["https://evil.example", "/"],
    ["/a\\b", "/"],
    ["", "/"],
    ["/ok", "/ok"],
    ["/has\u0000byte", "/"],
  ])("sanitises next %j to %j", async (input, expected) => {
    const server = makeServer({ env: codeEnv() })
    const cookie = await login(server)
    const url = await mintedUrl(server, cookie, input)
    expect(url.searchParams.get("next")).toBe(expected)
  })

  it("keeps safeNext decisions independent of the route", () => {
    expect(safeNext(undefined)).toBe("/")
    expect(safeNext("/a?b=1")).toBe("/a?b=1")
    // Protocol-relative input is rejected by the path check itself; the
    // scheme-shaped case never reaches a separate scheme test.
    expect(safeNext("//evil.example")).toBe("/")
    expect(safeNext("https://evil.example")).toBe("/")
  })

  it("mints a fresh jti per request and keeps tokens out of status and logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const server = makeServer({
      env: codeEnv(),
      codeProbe: async () => ({ reachable: true, version: HOST_VERSION }),
    })
    const cookie = await login(server)

    const first = (await mintedUrl(server, cookie)).searchParams.get("ticket") ?? ""
    const second = (await mintedUrl(server, cookie)).searchParams.get("ticket") ?? ""
    expect(first).not.toBe("")
    expect(second).not.toBe("")
    expect(first).not.toBe(second)
    expect(decodeClaims(first).jti).not.toBe(decodeClaims(second).jti)
    expect(decodeClaims(first).sub).toBe("owner")
    expect(decodeClaims(first).codeHost).toBe(ORIGIN)

    const status = await server.app.request("/api/code/status", { headers: { cookie } })
    const statusBody = await status.text()
    expect(statusBody).not.toContain(first)
    expect(statusBody).not.toContain(second)

    const logged = [
      ...log.mock.calls,
      ...warn.mock.calls,
      ...error.mock.calls,
    ]
      .flat()
      .map((entry) => String(entry))
      .join("\n")
    expect(logged).not.toContain(first)
    expect(logged).not.toContain(second)
    expect(logged).not.toContain(SECRET)
  })
})

describe("ticket throttle", () => {
  it("returns 429 on the 21st mint inside the window", async () => {
    const server = makeServer({ env: codeEnv() })
    const cookie = await login(server)
    for (let index = 0; index < 20; index += 1) {
      expect((await mint(server, cookie)).status).toBe(200)
    }
    const limited = await mint(server, cookie)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("resets the counter after the window", async () => {
    let now = 0
    const throttle = new FixedWindowThrottle({
      limit: 20,
      windowMs: 60_000,
      now: () => now,
    })
    const server = makeServer({ env: codeEnv(), codeTicketThrottle: throttle })
    const cookie = await login(server)
    for (let index = 0; index < 20; index += 1) {
      expect((await mint(server, cookie)).status).toBe(200)
    }
    expect((await mint(server, cookie)).status).toBe(429)
    now = 60_000
    expect((await mint(server, cookie)).status).toBe(200)
  })
})

describe("Code host status", () => {
  it("matches a host on the supported major", async () => {
    const server = makeServer({
      env: codeEnv(),
      codeProbe: async () => ({ reachable: true, version: HOST_VERSION }),
    })
    const cookie = await login(server)
    const response = await server.app.request("/api/code/status", { headers: { cookie } })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await json<CodeStatusResponse>(response)).toEqual({
      configured: true,
      reachable: true,
      version: HOST_VERSION,
      expectedVersion: SUPPORTED_OPENCODE_MAJOR_LABEL,
      matches: true,
    })
  })

  it("accepts a minor skew without warning", async () => {
    const server = makeServer({
      env: codeEnv(),
      codeProbe: async () => ({ reachable: true, version: "2.4.0" }),
    })
    const cookie = await login(server)
    const body = await json<CodeStatusResponse>(
      await server.app.request("/api/code/status", { headers: { cookie } }),
    )
    expect(body.version).toBe("2.4.0")
    expect(body.expectedVersion).toBe(SUPPORTED_OPENCODE_MAJOR_LABEL)
    expect(body.matches).toBe(true)
  })

  it("warns on a major skew without blocking", async () => {
    const server = makeServer({
      env: codeEnv(),
      codeProbe: async () => ({ reachable: true, version: "3.0.0" }),
    })
    const cookie = await login(server)
    const body = await json<CodeStatusResponse>(
      await server.app.request("/api/code/status", { headers: { cookie } }),
    )
    expect(body.reachable).toBe(true)
    expect(body.version).toBe("3.0.0")
    expect(body.matches).toBe(false)
  })

  it("treats a non-2xx probe as unreachable without upstream text", async () => {
    const probe = createCodeProbe(
      (async () => new Response("upstream boom", { status: 502 })) as typeof fetch,
    )
    const server = makeServer({ env: codeEnv(), codeProbe: probe })
    const cookie = await login(server)
    const response = await server.app.request("/api/code/status", { headers: { cookie } })
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({
      configured: true,
      reachable: false,
      expectedVersion: SUPPORTED_OPENCODE_MAJOR_LABEL,
      matches: false,
    })
    expect(text).not.toContain("boom")
  })

  it("treats a malformed health body as unreachable", async () => {
    const probe = createCodeProbe(
      (async () => Response.json({ ok: true })) as typeof fetch,
    )
    const server = makeServer({ env: codeEnv(), codeProbe: probe })
    const cookie = await login(server)
    const body = await json<CodeStatusResponse>(
      await server.app.request("/api/code/status", { headers: { cookie } }),
    )
    expect(body.reachable).toBe(false)
    expect(body).not.toHaveProperty("version")
  })

  it("times out a hanging probe", async () => {
    const hanging = ((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch
    const server = makeServer({ env: codeEnv(), codeProbe: createCodeProbe(hanging) })
    const cookie = await login(server)
    const body = await json<CodeStatusResponse>(
      await server.app.request("/api/code/status", { headers: { cookie } }),
    )
    expect(body.reachable).toBe(false)
    expect(body).not.toHaveProperty("version")
  })

  it("caches the probe result for ten seconds", async () => {
    let now = 0
    let calls = 0
    const probe = async () => {
      calls += 1
      return { reachable: true, version: HOST_VERSION }
    }
    const server = makeServer({ env: codeEnv(), codeProbe: probe, codeNow: () => now })
    const cookie = await login(server)

    await server.app.request("/api/code/status", { headers: { cookie } })
    await server.app.request("/api/code/status", { headers: { cookie } })
    expect(calls).toBe(1)

    now = 10_001
    await server.app.request("/api/code/status", { headers: { cookie } })
    expect(calls).toBe(2)
  })

  it("probes with redirects disabled", async () => {
    let seen: RequestInit | undefined
    const stub = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init
      return Response.json({ ok: true, version: PINNED_OPENCODE_VERSION })
    }) as typeof fetch

    const result = await createCodeProbe(stub)(ORIGIN, 1_000)
    expect(result).toEqual({ reachable: true, version: PINNED_OPENCODE_VERSION })
    // A redirect would let another origin answer the probe.
    expect(seen?.redirect).toBe("error")
  })

  it("bounds a hostile version before it reaches the client", async () => {
    const version = `2.3.0-${"x".repeat(200)}`
    const probe = createCodeProbe(
      (async () => Response.json({ ok: true, version })) as typeof fetch,
    )
    const server = makeServer({ env: codeEnv(), codeProbe: probe })
    const cookie = await login(server)
    const body = await json<CodeStatusResponse>(
      await server.app.request("/api/code/status", { headers: { cookie } }),
    )
    expect(body.reachable).toBe(true)
    expect(body.version).toHaveLength(64)
    expect(body.version?.startsWith("2.3.0-")).toBe(true)
    expect(body.matches).toBe(false)
  })

  it("bounds the health body it reads from a hostile host", async () => {
    let pulls = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1_024).fill(0x20))
      },
    })
    const probe = createCodeProbe(
      (async () => new Response(endless, { status: 200 })) as typeof fetch,
    )
    const server = makeServer({ env: codeEnv(), codeProbe: probe })
    const cookie = await login(server)
    const body = await json<CodeStatusResponse>(
      await server.app.request("/api/code/status", { headers: { cookie } }),
    )
    expect(body.reachable).toBe(false)
    expect(body).not.toHaveProperty("version")
    expect(pulls).toBeLessThan(10)
  })
})

describe("configured /api/info", () => {
  it("reports the surface as configured", async () => {
    const server = makeServer({ env: codeEnv() })
    const cookie = await login(server)
    const body = await json<{ code: { configured: boolean; expectedVersion: string } }>(
      await server.app.request("/api/info", { headers: { cookie } }),
    )
    expect(body.code).toEqual({ configured: true, expectedVersion: SUPPORTED_OPENCODE_MAJOR_LABEL })
  })

  it("defaults to no Code host", () => {
    expect(makeConfig().CODE_HOST_ORIGIN).toBe("")
  })
})
