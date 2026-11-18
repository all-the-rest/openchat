import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { runSmoke } from "../src/smoke"
import { parseSmokeArgs, runCli } from "../src/smoke-args"

interface StubOptions {
  mode?: string
  infoBody?: string
  /** Default true; `false` behaves like AUTH_MODE=basic (no cookie). */
  session?: boolean
  /** Default true; `false` never sends the keepalive comment. */
  heartbeat?: boolean
  /** Default false; adds `Secure` to the session cookie (https deployments). */
  secure?: boolean
}

const servers: Server[] = []
const SESSION_COOKIE = "oc_session=abc"

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "string" || address === null) {
        throw new Error("Unexpected address")
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function authorized(request: IncomingMessage): boolean {
  const cookie = request.headers.cookie ?? ""
  if (cookie.includes(SESSION_COOKIE)) return true
  const expected = `Basic ${Buffer.from("owner:secret").toString("base64")}`
  return request.headers.authorization === expected
}

async function startStub(options: StubOptions = {}): Promise<string> {
  const mode = options.mode ?? "live"
  const session = options.session ?? true
  const heartbeat = options.heartbeat ?? true
  const secure = options.secure ?? false
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? "/"
    if (url === "/healthz") {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ ok: true, mode, version: "test" }))
      return
    }
    if (url === "/api/auth/login" && request.method === "POST") {
      let body = ""
      request.on("data", (chunk) => {
        body += String(chunk)
      })
      request.on("end", () => {
        const password = (JSON.parse(body) as { password?: string }).password
        if (password !== "secret") {
          response.statusCode = 401
          response.end(JSON.stringify({ error: { code: "invalid_credentials" } }))
          return
        }
        if (session) {
          response.setHeader(
            "set-cookie",
            `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
          )
        }
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ user: "owner" }))
      })
      return
    }
    if (url === "/api/info") {
      if (!authorized(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: { code: "unauthenticated" } }))
        return
      }
      response.setHeader("content-type", "application/json")
      response.end(
        options.infoBody ??
          JSON.stringify({
            server: { mode, workspace: "/workspace", version: "test" },
            dictation: { enabled: false },
          }),
      )
      return
    }
    if (url === "/api/events") {
      if (!authorized(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: { code: "unauthenticated" } }))
        return
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      })
      response.write("retry: 2000\n\n")
      let timer: ReturnType<typeof setTimeout> | undefined
      if (heartbeat) {
        timer = setTimeout(() => {
          response.write(": heartbeat\n\n")
        }, 20)
      }
      request.on("close", () => {
        if (timer !== undefined) clearTimeout(timer)
      })
      return
    }
    response.statusCode = 404
    response.end()
  })
  servers.push(server)
  return listen(server)
}

/** Re-points the documented https origin at the local http stub. */
function rewriteHost(baseUrl: string): typeof fetch {
  return (input, init) =>
    fetch(String(input).replace(/^https:\/\/chat\.example\.com/i, baseUrl), init)
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

describe("runSmoke", () => {
  it("passes health, login, info and the event stream", async () => {
    const baseUrl = await startStub()
    const result = await runSmoke({
      baseUrl,
      password: "secret",
      streamMs: 300,
      heartbeatMs: 500,
      forbidden: ["stt-secret"],
    })

    expect(result.failed).toBe(0)
    expect(result.checks.map((entry) => entry.name)).toEqual([
      "health",
      "login",
      "info",
      "events",
      "no-secrets",
    ])
    const login = result.checks.find((entry) => entry.name === "login")
    expect(login?.detail).toContain("session cookie")
    const events = result.checks.find((entry) => entry.name === "events")
    expect(events?.detail).toContain("x-accel-buffering=no")
    expect(events?.detail).toContain("no-transform")
    expect(events?.detail).toContain("heartbeat=true")
  })

  it("falls back to Basic auth when the deployment sets no cookie", async () => {
    const baseUrl = await startStub({ session: false })
    const result = await runSmoke({
      baseUrl,
      password: "secret",
      streamMs: 300,
      heartbeatMs: 500,
    })

    expect(result.failed).toBe(0)
    expect(result.checks.find((entry) => entry.name === "login")?.detail).toContain(
      "Basic fallback",
    )
    expect(result.checks.find((entry) => entry.name === "info")?.ok).toBe(true)
  })

  it("fails login, info and events with a wrong password", async () => {
    const baseUrl = await startStub()
    const result = await runSmoke({ baseUrl, password: "wrong", streamMs: 50 })

    expect(result.checks.find((entry) => entry.name === "health")?.ok).toBe(true)
    expect(result.checks.find((entry) => entry.name === "login")?.ok).toBe(false)
    expect(result.checks.find((entry) => entry.name === "info")?.ok).toBe(false)
    expect(result.checks.find((entry) => entry.name === "events")?.ok).toBe(false)
  })

  it("fails when the deployment is not live", async () => {
    const baseUrl = await startStub({ mode: "fake" })
    const result = await runSmoke({ baseUrl, password: "secret", streamMs: 50 })

    expect(result.failed).toBeGreaterThan(0)
    expect(result.checks.find((entry) => entry.name === "health")?.ok).toBe(false)
    expect(result.checks.find((entry) => entry.name === "info")?.ok).toBe(false)
  })

  it("accepts a fake deployment when the caller allows it", async () => {
    const baseUrl = await startStub({ mode: "fake" })
    const result = await runSmoke({
      baseUrl,
      password: "secret",
      // The window starts before the request, so it has to cover connect +
      // first chunk; 50 ms was enough on an idle machine and not under load.
      streamMs: 500,
      requireLive: false,
    })

    expect(result.failed).toBe(0)
  })

  it("fails when the keepalive comment never arrives", async () => {
    const baseUrl = await startStub({ heartbeat: false })
    const result = await runSmoke({
      baseUrl,
      password: "secret",
      streamMs: 20,
      heartbeatMs: 80,
    })

    const events = result.checks.find((entry) => entry.name === "events")
    expect(events?.ok).toBe(false)
    expect(events?.detail).toContain("heartbeat=false")
  })

  it("requires Secure on an https deployment", async () => {
    const baseUrl = await startStub({ secure: false })
    const withoutSecure = await runSmoke({
      baseUrl: "https://chat.example.com",
      fetchImpl: rewriteHost(baseUrl),
      password: "secret",
      streamMs: 300,
      heartbeatMs: 0,
    })
    expect(withoutSecure.checks.find((entry) => entry.name === "login")?.ok).toBe(false)
    expect(withoutSecure.checks.find((entry) => entry.name === "login")?.detail).toContain(
      "cookie is missing required flags",
    )

    const secureBase = await startStub({ secure: true })
    const withSecure = await runSmoke({
      baseUrl: "HTTPS://chat.example.com",
      fetchImpl: rewriteHost(secureBase),
      password: "secret",
      streamMs: 300,
      heartbeatMs: 0,
    })
    expect(withSecure.checks.find((entry) => entry.name === "login")?.detail).toContain("Secure")
    expect(withSecure.failed).toBe(0)
  })

  it("fails when a forbidden string reaches a response body", async () => {
    const baseUrl = await startStub({
      infoBody: JSON.stringify({
        server: { mode: "live", workspace: "/workspace" },
        upstream: "http://opencode:4096",
      }),
    })
    const result = await runSmoke({
      baseUrl,
      password: "secret",
      streamMs: 50,
      forbidden: ["http://opencode:4096"],
    })

    expect(result.checks.find((entry) => entry.name === "no-secrets")?.ok).toBe(false)
    expect(result.failed).toBe(1)
  })
})

describe("parseSmokeArgs", () => {
  it("reads flags and falls back to the environment", () => {
    const args = parseSmokeArgs(
      ["--url", "http://127.0.0.1:8787", "--stream-ms", "250", "--forbid", "secret-1"],
      {
        OPENCHAT_PASSWORD: "from-env",
        OPENCHAT_USER: "owner",
        SMOKE_HEARTBEAT_MS: "1500",
      },
    )

    expect(args.url).toBe("http://127.0.0.1:8787")
    expect(args.password).toBe("from-env")
    expect(args.user).toBe("owner")
    expect(args.streamMs).toBe(250)
    expect(args.heartbeatMs).toBe(1500)
    expect(args.forbidden).toEqual(["secret-1"])
    expect(args.requireLive).toBe(true)
  })

  it("knows --allow-fake, ignores a bare -- and rejects bad input", () => {
    expect(parseSmokeArgs(["--allow-fake"], {}).requireLive).toBe(false)
    // A bare `--` from `pnpm run … --` is not an argument.
    expect(parseSmokeArgs(["--", "--allow-fake"], {}).requireLive).toBe(false)
    expect(() => parseSmokeArgs(["--nope"], {})).toThrow("Unknown argument")
    expect(() => parseSmokeArgs(["--stream-ms", "abc"], {})).toThrow("--stream-ms")
    expect(() => parseSmokeArgs(["--heartbeat-ms"], {})).toThrow("requires a value")
    expect(() => parseSmokeArgs([], { SMOKE_STREAM_MS: "0" })).toThrow("SMOKE_STREAM_MS")
  })
})

describe("runCli", () => {
  it("returns 2 for missing or invalid input", async () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)

    expect(await runCli([], {}, { log })).toBe(2)
    expect(await runCli(["--url", "http://127.0.0.1:1"], {}, { log })).toBe(2)
    expect(await runCli(["--stream-ms", "abc"], {}, { log })).toBe(2)
    expect(await runCli(["--heartbeat-ms"], {}, { log })).toBe(2)
    expect(lines.join("\n")).toContain("missing --password")
  })

  it("returns 0 on a passing deployment and 1 on a failing one", async () => {
    const baseUrl = await startStub()
    const lines: string[] = []
    const log = (line: string) => lines.push(line)

    expect(
      await runCli(
        ["--url", baseUrl, "--password", "secret", "--stream-ms", "300", "--heartbeat-ms", "500"],
        {},
        { log },
      ),
    ).toBe(0)
    expect(lines.at(-1)).toBe("smoke: PASS")

    const failing = await startStub({ mode: "fake" })
    expect(
      await runCli(["--url", failing, "--password", "secret", "--stream-ms", "50"], {}, { log }),
    ).toBe(1)
    expect(lines.at(-1)).toContain("smoke: FAIL")
  })

  it("warns about cleartext http to a non-loopback host", async () => {
    const lines: string[] = []
    await runCli(
      ["--url", "http://10.0.0.5:8787", "--password", "secret", "--stream-ms", "1"],
      {},
      {
        log: (line) => lines.push(line),
        fetchImpl: async () => {
          throw new Error("offline")
        },
      },
    )
    expect(lines[0]).toContain("warning: plain http")
  })
})
