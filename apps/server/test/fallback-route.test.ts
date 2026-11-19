import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { FallbackStatusResponse } from "@openchat/contracts"
import { FakeBackend } from "@openchat/opencode"
import { createApp } from "../src/app"
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
      FALLBACK_PAID_DAILY_CAP: "3",
    })
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const ledger = new UsageLedger({ directory: await directory() })
    const app = createApp({ config, backend, usageLedger: ledger })
    const cookie = await login({ app, backend, config })

    const body = await readFallback(app, cookie)
    expect(body).toEqual({
      configured: true,
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
      "paidDailyCap",
      "paidTurnsToday",
      "turnsToday",
    ])
    expect(JSON.stringify(body)).not.toContain(config.FALLBACK_USAGE_DIR)
  })

  it("reflects today's paid and free ledger counters", async () => {
    const config = makeConfig({ FALLBACK_PAID_DAILY_CAP: "5" })
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
