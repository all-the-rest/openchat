import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MEMORY_INDEX_KEY } from "@openchat/contracts"
import type { MemoryOp, MemoryOpResult, SessionInfo } from "@openchat/contracts"
import type { AppEnv } from "../src/app"
import { json, login, makeConfig, makeServer } from "./helpers"
import type { TestServer } from "./helpers"
import { createMemoryInvalidator } from "../src/memory-instructions"
import { registerMemoryInternalRoute } from "../src/memory-route"
import { createMemoryStore } from "../src/memory-store"

const TOKEN = "test-memory-internal-token-0123456789"
const TEXT = "Prefers tea over coffee"
const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-memory-injection-"))
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

async function post(
  server: { app: Hono<AppEnv> },
  body: unknown,
): Promise<Response> {
  return server.app.request("/internal/memory", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
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
async function seed(server: { app: Hono<AppEnv> }, text = TEXT): Promise<string> {
  const response = await post(server, writeOp(text))
  expect(response.status).toBe(200)
  const result = await json<MemoryOpResult>(response)
  expect(result.ids).toHaveLength(1)
  return result.ids?.[0] ?? ""
}

describe("memory injection on session create", () => {
  it("puts a fact written through the internal route into the next session", async () => {
    const server = serverFor(await tempDir())
    const id = await seed(server, "Prefers oat milk")
    const cookie = await login(server)
    const created = await json<SessionInfo>(
      await server.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    )
    const injected = server.backend.getInstruction(created.id, MEMORY_INDEX_KEY) ?? ""
    expect(injected).toContain(id)
    expect(injected).toContain("Prefers oat milk")

    await post(server, {
      op: "update",
      updates: [{ id, text: "Prefers soy milk" }],
      actor: "test",
    })
    const next = await json<SessionInfo>(
      await server.app.request("/api/sessions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    )
    const updated = server.backend.getInstruction(next.id, MEMORY_INDEX_KEY) ?? ""
    expect(updated).not.toContain(id)
    expect(updated).toContain("Prefers soy milk")
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

  it("recovers sessions listed by the backend after a restart", async () => {
    const dir = await tempDir()
    const store = createMemoryStore({ dir })
    const sessionID = `ses_after_restart_${dir}`
    const backend = {
      putInstruction: vi.fn(async () => {}),
      listSessions: vi.fn(async () => [{ id: sessionID }]),
    }
    // A fresh route instance owns a fresh invalidator, as after a restart.
    const app = new Hono<AppEnv>()
    registerMemoryInternalRoute(app, {
      config: makeConfig(env(dir)),
      store,
      backends: backend,
    })
    const response = await post({ app }, writeOp())
    expect(response.status).toBe(200)
    expect(backend.listSessions).toHaveBeenCalled()
    expect(backend.putInstruction).toHaveBeenCalledWith(
      sessionID, MEMORY_INDEX_KEY, expect.stringContaining("# Memory Index"),
    )
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
