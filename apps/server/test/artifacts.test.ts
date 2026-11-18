import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_URL_TTL_SECONDS,
} from "@openchat/contracts"
import type { ArtifactResponse } from "@openchat/contracts"
import { ArtifactSigner } from "../src/artifacts-sign"
import { ARTIFACT_BODY_MAX_BYTES } from "../src/limits"
import { FixedWindowThrottle } from "../src/throttle"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const HOST = "http://artifacts.example:4100"
const KEY = "test-artifact-signing-key-0123456789"
const HTML = "<!doctype html><html><body>hello</body></html>"
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)

const dirs: string[] = []

async function artifactDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-artifacts-"))
  dirs.push(dir)
  return dir
}

function env(dir: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ARTIFACT_HOST_URL: HOST,
    ARTIFACT_SIGNING_KEY: KEY,
    ARTIFACTS_DIR: dir,
    ...overrides,
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function post(
  server: TestServer,
  cookie: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function signedParts(url: string) {
  const parsed = new URL(url)
  return {
    origin: parsed.origin,
    path: parsed.pathname,
    exp: parsed.searchParams.get("exp") ?? "",
    sig: parsed.searchParams.get("sig") ?? "",
  }
}

describe("artifact route auth", () => {
  it.each([
    ["list", "/api/artifacts", "GET", {}],
    ["create", "/api/artifacts", "POST", { "content-type": "application/json" }],
    ["read", `/api/artifacts/${"a".repeat(64)}`, "GET", {}],
    ["download", `/api/artifacts/${"a".repeat(64)}/download`, "GET", {}],
  ])("requires a session for %s", async (_label, path, method, headers) => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await server.app.request(path, { method, headers })
    expect(response.status).toBe(401)
  })
})

describe("unconfigured artifact surface", () => {
  it("reports it in /api/info so the UI can hide the entry", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const body = await json<{ artifacts: { available: boolean } }>(
      await server.app.request("/api/info", { headers: { cookie } }),
    )
    expect(body.artifacts).toEqual({ available: false })
  })

  it("answers 503 with a fixed message for create and read", async () => {
    const server = makeServer()
    const cookie = await login(server)
    for (const response of [
      await post(server, cookie, { title: "x", html: HTML }),
      await server.app.request(`/api/artifacts/${"a".repeat(64)}`, { headers: { cookie } }),
    ]) {
      expect(response.status).toBe(503)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "artifacts_unavailable",
          message: "Artifact storage is not configured",
        },
      })
      expect(text).not.toContain(KEY)
    }
  })

  it("answers an empty list rather than an error", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/artifacts", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await json(response)).toEqual([])
  })

  it("hides the surface when only one half is configured", async () => {
    const server = makeServer({ env: { ARTIFACT_HOST_URL: HOST } })
    const cookie = await login(server)
    expect((await post(server, cookie, { title: "x", html: HTML })).status).toBe(503)
  })
})

describe("create artifact", () => {
  it("stores the document and returns a signed URL", async () => {
    const dir = await artifactDir()
    const server = makeServer({ env: env(dir), artifactsNow: () => NOW })
    const cookie = await login(server)
    const response = await post(server, cookie, { title: "  Report  ", html: HTML })
    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")

    const body = await json<ArtifactResponse>(response)
    expect(Object.keys(body).sort()).toEqual(
      ["bytes", "createdAt", "expiresAt", "id", "title", "url"],
    )
    expect(body.id).toMatch(/^[0-9a-f]{64}$/)
    expect(body.title).toBe("Report")
    expect(body.bytes).toBe(Buffer.byteLength(HTML))
    expect(body.createdAt).toBe(new Date(NOW).toISOString())

    const exp = Math.floor(NOW / 1000) + ARTIFACT_URL_TTL_SECONDS
    expect(body.expiresAt).toBe(new Date(exp * 1000).toISOString())
    const parts = signedParts(body.url)
    expect(parts.origin).toBe(HOST)
    expect(parts.path).toBe(`/a/${body.id}`)
    expect(parts.exp).toBe(String(exp))
    expect(
      new ArtifactSigner({ key: KEY, now: () => NOW }).verify(
        body.id,
        parts.exp,
        parts.sig,
      ),
    ).toBe(true)

    await expect(readFile(join(dir, body.id, "index.html"), "utf8")).resolves.toBe(HTML)
    const meta: unknown = JSON.parse(await readFile(join(dir, body.id, "meta.json"), "utf8"))
    expect(meta).toEqual({ title: "Report", bytes: body.bytes, createdAt: body.createdAt })
  })

  it("accepts a document above the generic JSON cap", async () => {
    const dir = await artifactDir()
    const server = makeServer({ env: env(dir) })
    const cookie = await login(server)
    const html = `<!doctype html><html><body>${"a".repeat(300 * 1024)}</body></html>`
    const response = await post(server, cookie, { title: "big", html })
    expect(response.status).toBe(201)
    const body = await json<ArtifactResponse>(response)
    expect(body.bytes).toBe(Buffer.byteLength(html))
    await expect(readFile(join(dir, body.id, "index.html"), "utf8")).resolves.toBe(html)
  })

  it("keeps the first title for an identical document", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    const first = await json<ArtifactResponse>(await post(server, cookie, { title: "One", html: HTML }))
    const secondResponse = await post(server, cookie, { title: "Two", html: HTML })
    expect(secondResponse.status).toBe(201)
    const second = await json<ArtifactResponse>(secondResponse)
    expect(second.id).toBe(first.id)
    expect(second.title).toBe("One")
    expect(second.createdAt).toBe(first.createdAt)
  })

  it.each([
    ["missing title", { html: HTML }, "title must be a string"],
    ["numeric title", { title: 7, html: HTML }, "title must be a string"],
    ["missing html", { title: "x" }, "html must be a string"],
    ["empty html", { title: "x", html: "" }, "html must not be empty"],
    [
      "not a document",
      { title: "x", html: "<div>hi</div>" },
      "html must start with <!doctype html or <html",
    ],
    [
      "too large",
      { title: "x", html: `<html>${"a".repeat(ARTIFACT_MAX_BYTES)}</html>` },
      `html must not exceed ${ARTIFACT_MAX_BYTES} bytes`,
    ],
  ])("rejects %s with a fixed reason", async (_label, body, reason) => {
    const dir = await artifactDir()
    const server = makeServer({ env: env(dir) })
    const cookie = await login(server)
    const response = await post(server, cookie, body)
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({
      error: { code: "artifacts_invalid", message: reason },
    })
    await expect(readdir(dir)).resolves.toEqual([])
  })

  it("rejects a non-object or malformed body", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    const malformed = await post(server, cookie, "{not json")
    expect(malformed.status).toBe(400)
    expect((await json<{ error: { code: string } }>(malformed)).error.code).toBe(
      "artifacts_invalid",
    )
    const array = await post(server, cookie, [1, 2, 3])
    expect((await json<{ error: { message: string } }>(array)).error.message).toBe(
      "title must be a string",
    )
  })

  it("requires a JSON content type", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    const response = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: JSON.stringify({ title: "x", html: HTML }),
    })
    expect(response.status).toBe(415)
  })

  it("caps the JSON envelope above the document limit", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    const response = await post(server, cookie, {
      title: "x",
      html: `<html>${"a".repeat(ARTIFACT_BODY_MAX_BYTES)}</html>`,
    })
    expect(response.status).toBe(413)
    expect(JSON.stringify(await json(response))).toContain(String(ARTIFACT_BODY_MAX_BYTES))
  })

  it("shortens an over-long title instead of rejecting it", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    const title = "T".repeat(ARTIFACT_TITLE_MAX + 50)
    const body = await json<ArtifactResponse>(await post(server, cookie, { title, html: HTML }))
    expect(body.title).toBe("T".repeat(ARTIFACT_TITLE_MAX))
  })

  it("never logs a signed URL or the signing key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    const body = await json<ArtifactResponse>(await post(server, cookie, { title: "x", html: HTML }))
    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map((entry) => String(entry))
      .join("\n")
    expect(logged).not.toContain(body.url)
    expect(logged).not.toContain(KEY)
  })
})

describe("artifact creation throttle", () => {
  it("answers 429 on the 21st created document inside the window", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    for (let index = 0; index < 20; index += 1) {
      const response = await post(server, cookie, {
        title: `doc ${index}`,
        html: `<html>${index}</html>`,
      })
      expect(response.status).toBe(201)
    }
    const limited = await post(server, cookie, { title: "last", html: "<html>last</html>" })
    expect(limited.status).toBe(429)
    expect((await json<{ error: { code: string } }>(limited)).error.code).toBe(
      "too_many_requests",
    )
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("does not spend the budget on rejected bodies", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    for (let index = 0; index < 25; index += 1) {
      expect((await post(server, cookie, { title: "x", html: "nope" })).status).toBe(400)
    }
    const accepted = await post(server, cookie, { title: "ok", html: HTML })
    expect(accepted.status).toBe(201)
  })

  it("resets after the window", async () => {
    let now = 0
    const throttle = new FixedWindowThrottle({ limit: 20, windowMs: 60_000, now: () => now })
    const server = makeServer({ env: env(await artifactDir()), artifactsThrottle: throttle })
    const cookie = await login(server)
    for (let index = 0; index < 20; index += 1) {
      await post(server, cookie, { title: `d${index}`, html: `<html>${index}</html>` })
    }
    expect((await post(server, cookie, { title: "x", html: HTML })).status).toBe(429)
    now = 60_000
    expect((await post(server, cookie, { title: "y", html: HTML })).status).toBe(201)
  })
})

describe("list and read artifacts", () => {
  it("lists newest first with freshly signed URLs", async () => {
    let now = NOW
    const server = makeServer({ env: env(await artifactDir()), artifactsNow: () => now })
    const cookie = await login(server)
    const first = await json<ArtifactResponse>(
      await post(server, cookie, { title: "first", html: "<html>1</html>" }),
    )
    now += 1_000
    const second = await json<ArtifactResponse>(
      await post(server, cookie, { title: "second", html: "<html>2</html>" }),
    )

    now += 60_000
    const response = await server.app.request("/api/artifacts", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const listed = await json<ArtifactResponse[]>(response)
    expect(listed.map((item) => item.title)).toEqual(["second", "first"])
    const laterExp = Math.floor(now / 1000) + ARTIFACT_URL_TTL_SECONDS
    expect(listed.map((item) => item.expiresAt)).toEqual([
      new Date(laterExp * 1000).toISOString(),
      new Date(laterExp * 1000).toISOString(),
    ])
    expect(listed[0]?.url).not.toBe(second.url)
    expect(signedParts(listed[0]?.url ?? "").exp).toBe(String(laterExp))
    expect(first.id).not.toBe(second.id)
  })

  it("reads one artifact by id with a fresh URL", async () => {
    const server = makeServer({ env: env(await artifactDir()), artifactsNow: () => NOW })
    const cookie = await login(server)
    const created = await json<ArtifactResponse>(
      await post(server, cookie, { title: "x", html: HTML }),
    )
    const response = await server.app.request(`/api/artifacts/${created.id}`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await json<ArtifactResponse>(response)
    expect(body.id).toBe(created.id)
    expect(body.url).toBe(created.url)
  })

  it("answers 404 for unknown and unshaped ids without echoing them", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    for (const id of ["b".repeat(64), "B".repeat(64), "abc", `${"c".repeat(63)}z`, "null"]) {
      const response = await server.app.request(`/api/artifacts/${id}`, { headers: { cookie } })
      expect(response.status).toBe(404)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual({
        error: { code: "artifacts_unknown", message: "Unknown artifact" },
      })
      expect(text).not.toContain(id)
    }
  })

  it("lists an empty surface when nothing was written yet", async () => {
    const server = makeServer({
      env: env(join(tmpdir(), `openchat-missing-${Date.now()}`)),
    })
    const cookie = await login(server)
    const response = await server.app.request("/api/artifacts", { headers: { cookie } })
    expect(await json(response)).toEqual([])
  })
})
