import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ArtifactResponse, ArtifactWriteReceipt } from "@openchat/contracts"
import { ARTIFACT_FULL_THRESHOLD } from "../src/artifacts-internal"
import { ARTIFACT_BODY_MAX_BYTES } from "../src/limits"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const HOST = "http://artifacts.example:4100"
const KEY = "test-artifact-signing-key-0123456789"
const TOKEN = "test-internal-token-0123456789abcdef"
const HTML = "<!doctype html><html><body>hello</body></html>"

const dirs: string[] = []

async function artifactDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-artifacts-internal-"))
  dirs.push(dir)
  return dir
}

function env(dir: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ARTIFACT_HOST_URL: HOST,
    ARTIFACT_SIGNING_KEY: KEY,
    ARTIFACT_INTERNAL_TOKEN: TOKEN,
    ARTIFACTS_DIR: dir,
    ...overrides,
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface PostOptions {
  /** Defaults to the configured token; `null` omits the header entirely. */
  auth?: string | null
  headers?: Record<string, string>
}

async function post(
  server: TestServer,
  body: unknown,
  options: PostOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  }
  const auth = options.auth === undefined ? `Bearer ${TOKEN}` : options.auth
  if (auth !== null) headers.authorization = auth
  return server.app.request("/internal/artifacts", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function document(index: number): string {
  return `<!doctype html><html><body>app ${index}</body></html>`
}

describe("internal artifact route: bearer auth", () => {
  it("accepts the configured token without a session", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await post(server, { title: "App", html: HTML })
    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it.each([
    ["a missing header", { auth: null }],
    ["a wrong token", { auth: "Bearer wrong-token" }],
    ["a longer token", { auth: `Bearer ${TOKEN}x` }],
    ["a shorter token", { auth: `Bearer ${TOKEN.slice(0, -1)}` }],
    ["a basic credential", { auth: `Basic ${TOKEN}` }],
    ["an empty bearer", { auth: "Bearer " }],
    ["a token with trailing space and junk", { auth: `Bearer ${TOKEN} extra` }],
  ])("rejects %s", async (_label, options) => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await post(server, { title: "App", html: HTML }, options)
    expect(response.status).toBe(401)
    expect(await json(response)).toMatchObject({ error: { code: "unauthorized" } })
  })

  it("rejects an arbitrary token when the boot generated one", async () => {
    const server = makeServer({
      env: env(await artifactDir(), { ARTIFACT_INTERNAL_TOKEN: undefined }),
    })
    expect(server.config.ARTIFACT_INTERNAL_TOKEN.length).toBeGreaterThanOrEqual(32)
    const rejected = await post(server, { title: "App", html: HTML }, {
      auth: "Bearer some-other-token",
    })
    expect(rejected.status).toBe(401)
    const accepted = await post(server, { title: "App", html: HTML }, {
      auth: `Bearer ${server.config.ARTIFACT_INTERNAL_TOKEN}`,
    })
    expect(accepted.status).toBe(201)
  })

  it("answers 503 when the artifact surface is not configured", async () => {
    const server = makeServer({
      env: {
        ARTIFACT_INTERNAL_TOKEN: TOKEN,
        ARTIFACTS_DIR: await artifactDir(),
      },
    })
    const response = await post(server, { title: "App", html: HTML })
    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({ error: { code: "artifacts_unavailable" } })
  })
})

describe("internal artifact route: request shape", () => {
  it("requires a JSON content type", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await post(server, { title: "App", html: HTML }, {
      headers: { "content-type": "text/plain" },
    })
    expect(response.status).toBe(415)
    expect(await json(response)).toMatchObject({ error: { code: "unsupported_media_type" } })
  })

  it("answers 413 above the envelope cap", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const huge = "x".repeat(ARTIFACT_BODY_MAX_BYTES + 1024)
    const response = await post(server, { title: "App", html: huge })
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: "payload_too_large" } })
  })

  it.each([
    ["a non-object body", "null"],
    ["a malformed body", "{"],
  ])("rejects %s", async (_label, body) => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await post(server, body)
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "artifacts_invalid" } })
  })

  it("rejects a document without a header and echoes nothing", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await post(server, { title: "App", html: "SECRET-FRAGMENT" })
    expect(response.status).toBe(400)
    const body = await json<{ error: { code: string; message: string } }>(response)
    expect(body.error.code).toBe("artifacts_invalid")
    expect(body.error.message).toBe("html must start with <!doctype html or <html")
    expect(JSON.stringify(body)).not.toContain("SECRET-FRAGMENT")
  })
})

describe("internal artifact route: storage", () => {
  it("stores the document and returns a receipt without a URL", async () => {
    const dir = await artifactDir()
    const server = makeServer({ env: env(dir) })
    const response = await post(server, { title: "  App  ", html: HTML })
    expect(response.status).toBe(201)
    const receipt = await json<ArtifactWriteReceipt>(response)
    expect(receipt.artifactID).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.title).toBe("App")
    expect(receipt.bytes).toBe(Buffer.byteLength(HTML))
    expect(Object.keys(receipt).sort()).toEqual(["artifactID", "bytes", "title"])
    expect(await readFile(join(dir, receipt.artifactID, "index.html"), "utf8")).toBe(HTML)
  })

  it("dedupes identical documents and keeps the first title", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const first = await json<ArtifactWriteReceipt>(
      await post(server, { title: "First", html: HTML }),
    )
    const second = await json<ArtifactWriteReceipt>(
      await post(server, { title: "Second", html: HTML }),
    )
    expect(second.artifactID).toBe(first.artifactID)
    expect(second.title).toBe("First")
  })

  it("lists the stored artifact through the public read route", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const receipt = await json<ArtifactWriteReceipt>(
      await post(server, { title: "From the tool", html: HTML }),
    )
    const cookie = await login(server)
    const response = await server.app.request("/api/artifacts", { headers: { cookie } })
    expect(response.status).toBe(200)
    const list = await json<ArtifactResponse[]>(response)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: receipt.artifactID,
      title: "From the tool",
      bytes: receipt.bytes,
    })
    expect(list[0]?.url).toContain(`/a/${receipt.artifactID}?exp=`)
  })
})

describe("internal artifact route: capacity guard", () => {
  // More than `ARTIFACT_FULL_THRESHOLD` of the blocks are used.
  const full = async () => ({ blocks: 1000, bavail: 40 })
  const roomy = async () => ({ blocks: 1000, bavail: 900 })

  it("returns 507 artifacts_full with a fixed message and writes nothing", async () => {
    const dir = await artifactDir()
    const server = makeServer({ env: env(dir), artifactsStatfs: full })
    const response = await post(server, { title: "SECRET-TITLE", html: HTML })
    expect(response.status).toBe(507)
    const body = await json<{ error: { code: string; message: string } }>(response)
    expect(body.error.code).toBe("artifacts_full")
    expect(body.error.message).toBe("Artifact storage is full")
    expect(JSON.stringify(body)).not.toContain("SECRET-TITLE")
    expect(await readdir(dir)).toEqual([])
  })

  it("still writes when the store has room", async () => {
    const dir = await artifactDir()
    const server = makeServer({ env: env(dir), artifactsStatfs: roomy })
    const response = await post(server, { title: "App", html: HTML })
    expect(response.status).toBe(201)
    const receipt = await json<ArtifactWriteReceipt>(response)
    expect(await readdir(dir)).toEqual([receipt.artifactID])
  })

  it("accepts the first write when the directory does not exist yet", async () => {
    const root = await artifactDir()
    const dir = join(root, "not-created-yet")
    const missing = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    }
    const server = makeServer({ env: env(dir), artifactsStatfs: missing })
    const response = await post(server, { title: "First", html: HTML })
    expect(response.status).toBe(201)
    const receipt = await json<ArtifactWriteReceipt>(response)
    expect(await readFile(join(dir, receipt.artifactID, "index.html"), "utf8")).toBe(HTML)
  })

  it("allows a write exactly at the threshold", async () => {
    const dir = await artifactDir()
    const atThreshold = async () => ({
      blocks: 1000,
      bavail: Math.round(1000 * (1 - ARTIFACT_FULL_THRESHOLD)),
    })
    const server = makeServer({ env: env(dir), artifactsStatfs: atThreshold })
    expect((await post(server, { title: "App", html: HTML })).status).toBe(201)
  })

  it("checks authentication before capacity", async () => {
    const server = makeServer({ env: env(await artifactDir()), artifactsStatfs: full })
    const response = await post(server, { title: "App", html: HTML }, { auth: "Bearer wrong" })
    expect(response.status).toBe(401)
  })

  it("rejects a malformed envelope before probing capacity", async () => {
    let probed = false
    const server = makeServer({
      env: env(await artifactDir()),
      artifactsStatfs: async () => {
        probed = true
        return full()
      },
    })
    const response = await post(server, { title: "App", html: HTML, data: "eA==" })
    expect(response.status).toBe(400)
    expect(probed).toBe(false)
  })
})

describe("internal artifact route: throttle", () => {
  it("accepts 20 writes per window and rejects the 21st", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    for (let index = 0; index < 20; index += 1) {
      const response = await post(server, { title: `App ${index}`, html: document(index) })
      expect(response.status).toBe(201)
    }
    const limited = await post(server, { title: "App 21", html: document(21) })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBeTruthy()
    expect(await json(limited)).toMatchObject({ error: { code: "too_many_requests" } })
  })

  it("does not consume the budget with a rejected body", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    for (let index = 0; index < 25; index += 1) {
      const rejected = await post(server, { title: "App", html: "nope" })
      expect(rejected.status).toBe(400)
    }
    const accepted = await post(server, { title: "App", html: HTML })
    expect(accepted.status).toBe(201)
  })

  it("stops at the failed authentication before the budget", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    for (let index = 0; index < 25; index += 1) {
      const rejected = await post(server, { title: "App", html: document(index) }, {
        auth: "Bearer wrong",
      })
      expect(rejected.status).toBe(401)
    }
    const accepted = await post(server, { title: "App", html: HTML })
    expect(accepted.status).toBe(201)
  })
})

describe("internal artifact read route", () => {
  async function get(
    server: TestServer,
    id: string,
    auth: string | null = `Bearer ${TOKEN}`,
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (auth !== null) headers.authorization = auth
    return await server.app.request(`/internal/artifacts/${id}`, { headers })
  }

  it("returns the stored document byte for byte without a session", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const receipt = await json<ArtifactWriteReceipt>(
      await post(server, { title: "Template", html: HTML }),
    )
    const response = await get(server, receipt.artifactID)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe(HTML)
  })

  it.each([
    ["a missing header", null],
    ["a wrong token", "Bearer wrong-token"],
    ["a basic credential", `Basic ${TOKEN}`],
  ])("rejects %s", async (_label, auth) => {
    const server = makeServer({ env: env(await artifactDir()) })
    const receipt = await json<ArtifactWriteReceipt>(
      await post(server, { title: "Template", html: HTML }),
    )
    const response = await get(server, receipt.artifactID, auth)
    expect(response.status).toBe(401)
    expect(await json(response)).toMatchObject({ error: { code: "unauthorized" } })
  })

  it("answers 404 for an unknown id and a malformed id alike", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const unknown = "0".repeat(64)
    for (const id of [unknown, "0".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      const response = await get(server, id)
      expect(response.status, id).toBe(404)
      expect(await json(response)).toMatchObject({ error: { code: "artifacts_unknown" } })
    }
  })

  it("answers 503 when the artifact surface is not configured", async () => {
    const server = makeServer({
      env: {
        ARTIFACT_INTERNAL_TOKEN: TOKEN,
        ARTIFACTS_DIR: await artifactDir(),
      },
    })
    const response = await get(server, "0".repeat(64))
    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({ error: { code: "artifacts_unavailable" } })
  })

  it("does not spend the write budget on reads", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const receipt = await json<ArtifactWriteReceipt>(
      await post(server, { title: "Template", html: HTML }),
    )
    for (let index = 0; index < 30; index += 1) {
      const response = await get(server, receipt.artifactID)
      expect(response.status).toBe(200)
    }
  })
})
