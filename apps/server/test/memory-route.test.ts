import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MEMORY_INDEX_KEY } from "@openchat/contracts"
import type { MemoryOp, MemoryOpResult, SessionInfo } from "@openchat/contracts"
import type { AppEnv } from "../src/app"
import { makeConfig, json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"
import {
  createMemoryInvalidator,
  INTERNAL_MEMORY_PATH,
  MEMORY_BODY_MAX_BYTES,
  registerMemoryInternalRoute,
} from "../src/memory-route"
import { createMemoryStore } from "../src/memory-store"

const TOKEN = "test-memory-internal-token-0123456789"
const TEXT = "Prefers tea over coffee"
const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-memory-route-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function env(dir: string, overrides: Record<string, string | undefined> = {}) {
  return { MEMORY_DATA_DIR: dir, MEMORY_INTERNAL_TOKEN: TOKEN, ...overrides }
}

function serverFor(dir: string): TestServer {
  return makeServer({ env: env(dir) })
}

interface PostOptions {
  /** Defaults to the configured token; `null` omits the header entirely. */
  auth?: string | null
  headers?: Record<string, string>
}

async function post(
  server: { app: Hono<AppEnv> },
  body: unknown,
  options: PostOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers }
  const auth = options.auth === undefined ? `Bearer ${TOKEN}` : options.auth
  if (auth !== null) headers.authorization = auth
  return server.app.request(INTERNAL_MEMORY_PATH, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function writeOp(text = TEXT): MemoryOp {
  return {
    op: "write",
    inputs: [{ kind: "preference", text, topic: "drinks", tags: ["drink"], trust: "explicit" }],
    actor: "test",
  }
}

/** Writes one fact through the internal route and returns its id. */
async function seed(server: { app: Hono<AppEnv> }): Promise<string> {
  const response = await post(server, writeOp())
  expect(response.status).toBe(200)
  const result = await json<MemoryOpResult>(response)
  expect(result.ids).toHaveLength(1)
  return result.ids?.[0] ?? ""
}

describe("memory internal route: bearer auth", () => {
  it("accepts the configured token without a session", async () => {
    const response = await post(serverFor(await tempDir()), { op: "stats" })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await json<MemoryOpResult>(response)).toMatchObject({ ok: true })
  })

  it.each([
    ["a missing header", { auth: null }],
    ["a wrong token", { auth: "Bearer wrong-token" }],
    ["a shorter token", { auth: `Bearer ${TOKEN.slice(0, -1)}` }],
    ["a longer token", { auth: `Bearer ${TOKEN}x` }],
    ["a basic credential", { auth: `Basic ${TOKEN}` }],
    ["an empty bearer", { auth: "Bearer " }],
  ])("rejects %s", async (_label, options) => {
    const response = await post(serverFor(await tempDir()), { op: "stats" }, options)
    expect(response.status).toBe(401)
    expect(await json(response)).toMatchObject({ error: { code: "unauthorized" } })
  })

  it("answers 503 when the token is unconfigured", async () => {
    const dir = await tempDir()
    const config = { ...makeConfig(env(dir)), MEMORY_INTERNAL_TOKEN: "" }
    const app = new Hono<AppEnv>()
    registerMemoryInternalRoute(app, { config, store: createMemoryStore({ dir }) })
    const response = await app.request(INTERNAL_MEMORY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ op: "stats" }),
    })
    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({ error: { code: "memory_unavailable" } })
  })
})

describe("memory internal route: request shape", () => {
  it("requires a JSON content type", async () => {
    const response = await post(serverFor(await tempDir()), { op: "stats" }, {
      headers: { "content-type": "text/plain" },
    })
    expect(response.status).toBe(415)
    expect(await json(response)).toMatchObject({ error: { code: "unsupported_media_type" } })
  })

  it("answers 413 above the envelope cap", async () => {
    const response = await post(serverFor(await tempDir()), {
      op: "write",
      inputs: [{ kind: "preference", text: "x".repeat(MEMORY_BODY_MAX_BYTES), topic: "big", actor: "t" }],
      actor: "test",
    })
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: "payload_too_large" } })
  })

  it.each([
    ["a malformed body", "{"],
    ["a non-object body", "null"],
    ["an unknown op", JSON.stringify({ op: "unknown" })],
    ["an empty batch", JSON.stringify({ op: "write", inputs: [], actor: "test" })],
  ])("rejects %s", async (_label, body) => {
    const response = await post(serverFor(await tempDir()), body)
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "memory_invalid" } })
  })

  it("returns a compact error result when the store rejects content", async () => {
    const response = await post(serverFor(await tempDir()), {
      op: "write",
      inputs: [{ kind: "preference", text: "my password is secret", topic: "bad", actor: "t" }],
      actor: "test",
    })
    expect(response.status).toBe(400)
    expect(await json<MemoryOpResult>(response)).toMatchObject({ ok: false })
  })
})

describe("memory internal route: operations", () => {
  it("index returns the current push layer", async () => {
    const result = await json<MemoryOpResult>(await post(serverFor(await tempDir()), { op: "index" }))
    expect(result.ok).toBe(true)
    expect(result.index).toContain("# Memory Index")
    expect(typeof result.entries).toBe("number")
  })

  it("write returns the new ids", async () => {
    const dir = await tempDir()
    expect(await seed(serverFor(dir))).toMatch(/^mem_/)
  })

  it("find ranks matching facts", async () => {
    const server = serverFor(await tempDir())
    await seed(server)
    const result = await json<MemoryOpResult>(
      await post(server, { op: "find", queries: ["tea"], limit: 10 }),
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows?.[0]?.text).toBe(TEXT)
  })

  it("get returns full facts", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server)
    const result = await json<MemoryOpResult>(await post(server, { op: "get", ids: [id] }))
    expect(result.facts?.map((fact) => fact.id)).toEqual([id])
  })

  it("update supersedes the old fact", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server)
    const result = await json<MemoryOpResult>(
      await post(server, {
        op: "update",
        updates: [{ id, text: "Prefers coffee now" }],
        actor: "test",
      }),
    )
    expect(result.facts?.[0]?.text).toBe("Prefers coffee now")
    expect(result.facts?.[0]?.supersedes).toContain(id)
  })

  it("delete keeps the row and records the reason", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server)
    const result = await json<MemoryOpResult>(
      await post(server, { op: "delete", ids: [id], reason: "obsolete", actor: "test" }),
    )
    expect(result.ids).toEqual([id])
    const fetched = await json<MemoryOpResult>(await post(server, { op: "get", ids: [id] }))
    expect(fetched.facts?.[0]?.status).toBe("deleted")
  })

  it("prune lists candidates on a dry run", async () => {
    const server = serverFor(await tempDir())
    await seed(server)
    const result = await json<MemoryOpResult>(
      await post(server, { op: "prune", dryRun: true, actor: "test" }),
    )
    expect(result.ok).toBe(true)
    expect(Array.isArray(result.candidates)).toBe(true)
    expect(result.removed).toEqual([])
  })

  it("stats reports counts", async () => {
    const server = serverFor(await tempDir())
    await seed(server)
    const result = await json<MemoryOpResult>(await post(server, { op: "stats" }))
    expect(result.stats?.active).toBe(1)
  })
})

describe("memory public routes", () => {
  it("rejects an anonymous reader", async () => {
    const server = serverFor(await tempDir())
    const response = await server.app.request("/api/memory")
    expect(response.status).toBe(401)
  })

  it("lists facts, audit and index", async () => {
    const server = serverFor(await tempDir())
    await seed(server)
    const cookie = await login(server)
    const body = await json<{ facts: unknown[]; audit: unknown[]; index: string }>(
      await server.app.request("/api/memory", { headers: { cookie } }),
    )
    expect(body.facts).toHaveLength(1)
    expect(body.audit.length).toBeGreaterThan(0)
    expect(body.index).toContain("# Memory Index")
  })

  it("patches a fact through the owner route", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server)
    const cookie = await login(server)
    const response = await server.app.request(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "Prefers tea with milk", status: "active", confirm: true }),
    })
    expect(response.status).toBe(200)
    expect(await json<{ text: string }>(response)).toMatchObject({ text: "Prefers tea with milk" })
  })

  it("rejects a malformed patch", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server)
    const cookie = await login(server)
    const response = await server.app.request(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ trust: "unknown" }),
    })
    expect(response.status).toBe(400)
  })

  it("deletes with a reason", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server)
    const cookie = await login(server)
    const response = await server.app.request(`/api/memory/${id}`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "owner request" }),
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true })
    const listed = await json<{ facts: Array<{ status: string }> }>(
      await server.app.request("/api/memory", { headers: { cookie } }),
    )
    expect(listed.facts[0]?.status).toBe("deleted")
  })

  it("requires a reason to delete", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server)
    const cookie = await login(server)
    const response = await server.app.request(`/api/memory/${id}`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(400)
  })

  it("exports a JSON attachment", async () => {
    const server = serverFor(await tempDir())
    await seed(server)
    const cookie = await login(server)
    const response = await server.app.request("/api/memory/export", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toContain("attachment")
    const body = await json<{ facts: unknown[]; audit: unknown[]; index: string }>(response)
    expect(body.facts).toHaveLength(1)
    expect(body.audit.length).toBeGreaterThan(0)
  })
})

describe("memory invalidation", () => {
  it("re-puts the index to a noted session after a write", async () => {
    const dir = await tempDir()
    const server = serverFor(dir)
    const put = vi.spyOn(server.backend, "putInstruction")
    const cookie = await login(server)
    const created = await json<SessionInfo>(
      await server.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    )
    put.mockClear()
    await post(server, writeOp())
    expect(put).toHaveBeenCalledWith(created.id, MEMORY_INDEX_KEY, expect.stringContaining("# Memory Index"))
  })

  it("ignores host errors on a re-put", async () => {
    const dir = await tempDir()
    const store = createMemoryStore({ dir })
    const backend = { putInstruction: vi.fn(async () => { throw new Error("host down") }) }
    const invalidator = createMemoryInvalidator(backend, store)
    const sessionID = `session-host-error-${dir}`
    invalidator.noteSession(sessionID)
    registerMemoryInternalRoute(new Hono<AppEnv>(), {
      config: makeConfig(env(dir)),
      store,
      invalidator,
    })
    await expect(invalidator.invalidate()).resolves.toBeUndefined()
    expect(backend.putInstruction).toHaveBeenCalledWith(
      sessionID, MEMORY_INDEX_KEY, expect.stringContaining("# Memory Index"),
    )
  })
})
