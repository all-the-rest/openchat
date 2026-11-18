import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { localDay, UsageLedger, UsageLedgerError } from "../src/usage-ledger"

const dirs: string[] = []

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-usage-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function at(day: number, hour = 12, minute = 0): number {
  return new Date(2026, 10, day, hour, minute).getTime()
}

function fileFor(dir: string, time: number): string {
  return join(dir, `${localDay(time)}.jsonl`)
}

describe("usage ledger", () => {
  it("appends one row per recorded entry and sums today", async () => {
    const dir = await directory()
    const time = at(18)
    const ledger = new UsageLedger({ directory: dir, now: () => time })

    await ledger.record({ providerID: "acme", modelID: "large", turns: 1, costMicros: 2_500 })
    await ledger.record({ providerID: "acme", modelID: "large", turns: 2, costMicros: 5_000 })

    expect(await ledger.spentToday()).toBe(7_500)
    expect(await ledger.turnsToday()).toBe(3)
    expect(await ledger.skippedToday()).toBe(0)

    const lines = (await readFile(fileFor(dir, time), "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      at: time,
      providerID: "acme",
      modelID: "large",
      turns: 1,
      costMicros: 2_500,
    })
  })

  it("rolls over at local midnight on the injected clock", async () => {
    const dir = await directory()
    let time = at(18, 23, 59)
    const ledger = new UsageLedger({ directory: dir, now: () => time })

    await ledger.record({ providerID: "acme", modelID: "large", turns: 1, costMicros: 100 })
    expect(await ledger.spentToday()).toBe(100)

    time = at(19, 0, 1)
    expect(await ledger.spentToday()).toBe(0)
    expect(await ledger.turnsToday()).toBe(0)

    await ledger.record({ providerID: "acme", modelID: "large", turns: 1, costMicros: 40 })
    expect(await ledger.spentToday()).toBe(40)

    const files = (await readdir(dir)).sort()
    expect(files).toEqual(
      [`${localDay(at(18, 23, 59))}.jsonl`, `${localDay(at(19, 0, 1))}.jsonl`].sort(),
    )
  })

  it("skips and counts corrupt lines instead of throwing", async () => {
    const dir = await directory()
    const time = at(18)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const valid = JSON.stringify({
      at: time,
      providerID: "acme",
      modelID: "large",
      turns: 2,
      costMicros: 900,
    })
    await writeFile(
      fileFor(dir, time),
      `${valid}\nnot json\n{"at":${time},"providerID":"acme"}\n`,
      { mode: 0o600 },
    )

    const ledger = new UsageLedger({ directory: dir, now: () => time })
    expect(await ledger.spentToday()).toBe(900)
    expect(await ledger.turnsToday()).toBe(2)
    expect(await ledger.skippedToday()).toBe(2)
  })

  it("creates the injected directory and a 0600 file", async () => {
    const parent = await directory()
    const dir = join(parent, "nested", "usage")
    const time = at(18)
    const ledger = new UsageLedger({ directory: dir, now: () => time })

    await ledger.record({ providerID: "acme", modelID: "large", turns: 1, costMicros: 1 })

    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(fileFor(dir, time))).mode & 0o777).toBe(0o600)
    expect((await readdir(parent)).sort()).toEqual(["nested"])
    expect((await readdir(dir)).sort()).toEqual([`${localDay(time)}.jsonl`])
  })

  it("refuses a row that would pass the byte cap without touching the file", async () => {
    const dir = await directory()
    const time = at(18)
    const ledger = new UsageLedger({ directory: dir, now: () => time })
    await ledger.record({ providerID: "acme", modelID: "large", turns: 1, costMicros: 1 })
    const size = (await stat(fileFor(dir, time))).size

    const capped = new UsageLedger({ directory: dir, now: () => time, maxFileBytes: size })
    await expect(
      capped.record({ providerID: "acme", modelID: "other", turns: 1, costMicros: 1 }),
    ).rejects.toMatchObject({ code: "usage_ledger_full" })
    expect((await stat(fileFor(dir, time))).size).toBe(size)
  })

  it("refuses the very first row when the cap is smaller than one row", async () => {
    const dir = await directory()
    const ledger = new UsageLedger({ directory: dir, now: () => at(18), maxFileBytes: 1 })

    await expect(
      ledger.record({ providerID: "acme", modelID: "large", turns: 1, costMicros: 1 }),
    ).rejects.toBeInstanceOf(UsageLedgerError)
    expect(await readdir(dir)).toEqual([])
  })

  it("rejects an invalid entry with a stable code", async () => {
    const dir = await directory()
    const ledger = new UsageLedger({ directory: dir, now: () => at(18) })

    await expect(
      ledger.record({ providerID: "", modelID: "large", turns: 1, costMicros: 1 }),
    ).rejects.toMatchObject({ code: "usage_ledger_invalid" })
    await expect(
      ledger.record({ providerID: "acme", modelID: "large", turns: -1, costMicros: 1 }),
    ).rejects.toMatchObject({ code: "usage_ledger_invalid" })
  })

  it("serialises concurrent appends", async () => {
    const dir = await directory()
    const ledger = new UsageLedger({ directory: dir, now: () => at(18) })
    await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        ledger.record({
          providerID: "acme",
          modelID: "large",
          turns: 1,
          costMicros: index,
        }),
      ),
    )

    expect(await ledger.turnsToday()).toBe(20)
    expect(await ledger.spentToday()).toBe(190)
    expect(await ledger.skippedToday()).toBe(0)
  })
})
