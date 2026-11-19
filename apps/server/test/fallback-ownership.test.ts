import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TurnPolicy } from "@openchat/contracts"
import { FakeBackend } from "@openchat/opencode"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createApp } from "../src/app"
import { FallbackEngine } from "../src/fallback-engine"
import { PAID_TURN_CAP_ERROR } from "../src/prompt-route"
import { UsageLedger } from "../src/usage-ledger"
import { json, login, makeConfig, openEvents } from "./helpers"

const dirs: string[] = []

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-fallback-ownership-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function policy(chain: TurnPolicy["chain"], paidDailyTurns = 10): TurnPolicy {
  return { surface: "chat", chain, paidDailyTurns, contextSoftCap: 0 }
}

const FREE = { providerID: "free", modelID: "glm", isFree: true }
const PAID = { providerID: "paid", modelID: "gpt" }

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function createSession(app: ReturnType<typeof createApp>, cookie: string) {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "Fallback ownership" }),
  })
  return json<{ id: string }>(res)
}

function prompt(
  app: ReturnType<typeof createApp>,
  cookie: string,
  sessionID: string,
  text: string,
) {
  return app.request(`/api/sessions/${sessionID}/prompt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  })
}

describe("server-owned fallback", () => {
  it("records the outcome and retries with no browser attached", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const record = vi.fn(async () => {})
    const engine = new FallbackEngine({
      backend,
      ledger: { record, paidTurnsToday: async () => 0 },
    })
    const app = createApp({
      config,
      backend,
      fallback: engine,
      chatPolicy: policy([FREE, PAID]),
    })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    // No `/api/events` stream is open for this prompt.
    const res = await prompt(app, cookie, id, "fallback: hello")
    expect(res.status).toBe(200)
    await until(() => record.mock.calls.length > 0)

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ providerID: "paid", modelID: "gpt" }),
    )
    // The retry reached the host too: the last recorded prompt is the next
    // chain model, not the failed first attempt.
    expect(backend.recordedPrompt(id)?.modelRef).toEqual(PAID)
    expect(engine.activeCount()).toBe(0)
  })

  it("subscribes to the host exactly once across two browser streams", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const subscribe = vi.spyOn(backend, "subscribe")
    const app = createApp({ config, backend, chatPolicy: policy([FREE, PAID]) })
    const cookie = await login({ app, backend, config })

    const first = await openEvents({ app, backend, config }, cookie)
    const second = await openEvents({ app, backend, config }, cookie)
    expect(subscribe).toHaveBeenCalledTimes(1)

    await first.close()
    await second.close()
  })
})

describe("paid daily cap admission", () => {
  it("refuses a paid first attempt once the cap is reached", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    await ledger.record({ providerID: "paid", modelID: "gpt", turns: 1, costMicros: 0 })
    const app = createApp({
      config,
      backend,
      usageLedger: ledger,
      chatPolicy: policy([PAID, FREE], 1),
    })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    const res = await prompt(app, cookie, id, "hello")
    expect(res.status).toBe(429)
    expect(await json(res)).toMatchObject({ error: { code: PAID_TURN_CAP_ERROR } })
    expect(backend.recordedPrompt(id)).toBeUndefined()
  })

  it("admits a free first attempt at the cap", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    await ledger.record({ providerID: "paid", modelID: "gpt", turns: 1, costMicros: 0 })
    const app = createApp({
      config,
      backend,
      usageLedger: ledger,
      chatPolicy: policy([FREE, PAID], 1),
    })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    const res = await prompt(app, cookie, id, "hello")
    expect(res.status).toBe(200)
  })
})
