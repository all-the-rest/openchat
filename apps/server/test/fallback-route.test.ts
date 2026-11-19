import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import type { FallbackStatusResponse } from "@openchat/contracts"
import { FakeBackend } from "@openchat/opencode"
import type { AppEnv } from "../src/app"
import { createApp } from "../src/app"
import { registerFallbackRoute } from "../src/fallback-route"
import { UsageLedger } from "../src/usage-ledger"
import { json, login, makeConfig } from "./helpers"

const dirs: string[] = []

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-fallback-route-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function readFallback(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<FallbackStatusResponse> {
  const res = await app.request("/api/fallback", { headers: { cookie } })
  expect(res.status).toBe(200)
  return json<FallbackStatusResponse>(res)
}

describe("GET /api/fallback", () => {
  it("reports an unconfigured chain without inventing entries", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    const app = createApp({ config, backend, usageLedger: ledger })
    const cookie = await login({ app, backend, config })

    expect(await readFallback(app, cookie)).toEqual({
      configured: false,
      invalid: false,
      chain: [],
      paidDailyCap: 0,
      paidTurnsToday: 0,
      turnsToday: 0,
    })
  })

  it("echoes the configured chain and cap resolved from the environment", async () => {
    const config = makeConfig({
      FALLBACK_CHAIN_JSON: JSON.stringify([
        { providerID: "free", modelID: "glm", isFree: true },
        { providerID: "paid", modelID: "gpt", variant: "fast", contextLimit: 128_000 },
      ]),
      FALLBACK_PAID_DAILY_TURNS: "3",
    })
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    const app = createApp({ config, backend, usageLedger: ledger })
    const cookie = await login({ app, backend, config })

    const body = await readFallback(app, cookie)
    expect(body).toEqual({
      configured: true,
      invalid: false,
      chain: [
        { providerID: "free", modelID: "glm", isFree: true },
        { providerID: "paid", modelID: "gpt", variant: "fast", contextLimit: 128_000 },
      ],
      paidDailyCap: 3,
      paidTurnsToday: 0,
      turnsToday: 0,
    })
    // Only the resolved fields and today's counters are part of the answer:
    // no raw environment value (settings echo the parsed chain) and no paths.
    expect(Object.keys(body).sort()).toEqual([
      "chain",
      "configured",
      "invalid",
      "paidDailyCap",
      "paidTurnsToday",
      "turnsToday",
    ])
    expect(JSON.stringify(body)).not.toContain(config.FALLBACK_USAGE_DIR)
  })

  it("reports an invalid chain setting instead of an empty one, without echoing it", async () => {
    const config = makeConfig({ FALLBACK_CHAIN_JSON: '{"apiKey":"sk-live-123"}' })
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    const warn = vi.fn()
    const app = createApp({ config, backend, usageLedger: ledger, warn })
    const cookie = await login({ app, backend, config })

    const body = await readFallback(app, cookie)
    expect(body).toMatchObject({
      configured: false,
      invalid: true,
      invalidReasonCode: "chain_shape",
      chain: [],
      paidDailyCap: 0,
    })
    // The readable reason stays in the boot log; only the stable code travels.
    expect(body).not.toHaveProperty("invalidReason")
    expect(JSON.stringify(body)).not.toContain("sk-live-123")
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['{"apiKey":"sk-live-123"}', "chain_shape"],
    ["not json at all", "chain_json"],
    ["[1]", "entry"],
  ])("classifies the invalid chain %s as %s", async (raw, code) => {
    const config = makeConfig({ FALLBACK_CHAIN_JSON: raw })
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    const app = createApp({ config, backend, usageLedger: ledger, warn: vi.fn() })
    const cookie = await login({ app, backend, config })

    const body = await readFallback(app, cookie)
    expect(body.invalid).toBe(true)
    expect(body.invalidReasonCode).toBe(code)
  })

  it("reports the engine's sticky ledger failure flag", async () => {
    const app = new Hono<AppEnv>()
    registerFallbackRoute(app, {
      policy: { surface: "chat", chain: [], paidDailyTurns: 0, contextSoftCap: 0 },
      ledger: { paidTurnsToday: async () => 0, turnsToday: async () => 0 },
      ledgerError: () => true,
    })

    expect(await json<FallbackStatusResponse>(await app.request("/api/fallback"))).toMatchObject({
      ledgerError: true,
    })
  })

  it("omits the ledger flag while no write has failed", async () => {
    const app = new Hono<AppEnv>()
    registerFallbackRoute(app, {
      policy: { surface: "chat", chain: [], paidDailyTurns: 0, contextSoftCap: 0 },
      ledger: { paidTurnsToday: async () => 0, turnsToday: async () => 0 },
      ledgerError: () => false,
    })

    const body = await json<FallbackStatusResponse>(await app.request("/api/fallback"))
    expect(body).not.toHaveProperty("ledgerError")
  })

  it("reflects today's paid and free ledger counters", async () => {
    const config = makeConfig({ FALLBACK_PAID_DAILY_TURNS: "5" })
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    await ledger.record({ providerID: "paid", modelID: "gpt", turns: 1, costMicros: 0 })
    await ledger.record({
      providerID: "free",
      modelID: "glm",
      turns: 1,
      costMicros: 0,
      isFree: true,
    })
    const app = createApp({ config, backend, usageLedger: ledger })
    const cookie = await login({ app, backend, config })

    const body = await readFallback(app, cookie)
    expect(body.paidTurnsToday).toBe(1)
    expect(body.turnsToday).toBe(2)
    expect(body.paidDailyCap).toBe(5)
  })
})
