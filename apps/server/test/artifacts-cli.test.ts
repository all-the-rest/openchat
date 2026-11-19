import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ArtifactMeta } from "@openchat/contracts"
import { planEviction, runEvictCli } from "../src/artifacts-evict"
import { ArtifactStore } from "../src/artifacts-store"

const DAY_MS = 86_400_000
const NOW = Date.parse("2026-06-01T00:00:00.000Z")

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function clockAt(value: number): { value: number } {
  return { value }
}

async function makeStore(): Promise<{ store: ArtifactStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-artifacts-cli-"))
  dirs.push(dir)
  return { store: new ArtifactStore({ dir, now: () => clock.value }), dir }
}

// One shared default clock for `makeStore`; tests set it before seeding.
const clock = clockAt(NOW)

async function seed(
  store: ArtifactStore,
  specs: ReadonlyArray<{ name: string; ageDays: number }>,
): Promise<Map<string, ArtifactMeta>> {
  const seeded = new Map<string, ArtifactMeta>()
  for (const spec of specs) {
    clock.value = NOW - spec.ageDays * DAY_MS
    const result = await store.create({
      title: spec.name,
      html: `<!doctype html><html><body>${spec.name}</body></html>`,
    })
    if (!result.ok) throw new Error(result.reason)
    seeded.set(spec.name, result.artifact)
  }
  return seeded
}

const FIXTURE = [
  { name: "old-1", ageDays: 30 },
  { name: "old-2", ageDays: 20 },
  { name: "mid", ageDays: 5 },
  { name: "new", ageDays: 1 },
]

describe("artifact eviction CLI", () => {
  it("dry-runs by default and deletes nothing", async () => {
    const { store } = await makeStore()
    const seeded = await seed(store, FIXTURE)
    const lines: string[] = []
    const exit = await runEvictCli(
      ["evict", "--older-than", "7", "--keep", "1"],
      {},
      { store, now: () => NOW, log: (line) => lines.push(line) },
    )
    expect(exit).toBe(0)
    expect(lines.filter((line) => line.startsWith("would delete"))).toHaveLength(2)
    expect(lines.some((line) => line.includes("no changes made"))).toBe(true)
    expect(lines.some((line) => line.startsWith("delete "))).toBe(false)
    for (const meta of seeded.values()) expect(await store.get(meta.id)).not.toBeNull()
  })

  it("--apply deletes only old artifacts beyond the keep count", async () => {
    const { store } = await makeStore()
    const seeded = await seed(store, FIXTURE)
    const lines: string[] = []
    const exit = await runEvictCli(
      ["evict", "--older-than", "7", "--keep", "1", "--apply"],
      {},
      { store, now: () => NOW, log: (line) => lines.push(line) },
    )
    expect(exit).toBe(0)
    expect(lines.filter((line) => line.startsWith("delete "))).toHaveLength(2)
    expect(await store.get(seeded.get("old-1")!.id)).toBeNull()
    expect(await store.get(seeded.get("old-2")!.id)).toBeNull()
    expect(await store.get(seeded.get("mid")!.id)).not.toBeNull()
    expect(await store.get(seeded.get("new")!.id)).not.toBeNull()
    expect(await store.listAll()).toHaveLength(2)
  })

  it("always keeps the newest artifacts even when they are old", async () => {
    const { store } = await makeStore()
    const seeded = await seed(store, [
      { name: "oldest", ageDays: 40 },
      { name: "second", ageDays: 35 },
      { name: "third", ageDays: 30 },
    ])
    const exit = await runEvictCli(
      ["evict", "--older-than", "7", "--keep", "2", "--apply"],
      {},
      { store, now: () => NOW, log: () => {} },
    )
    expect(exit).toBe(0)
    expect(await store.get(seeded.get("oldest")!.id)).toBeNull()
    expect(await store.get(seeded.get("second")!.id)).not.toBeNull()
    expect(await store.get(seeded.get("third")!.id)).not.toBeNull()
  })

  it("reads ARTIFACTS_DIR from the environment when no store is injected", async () => {
    const { store, dir } = await makeStore()
    await seed(store, FIXTURE)
    const lines: string[] = []
    const exit = await runEvictCli(
      ["evict", "--older-than", "7", "--keep", "1"],
      { ARTIFACTS_DIR: dir },
      { now: () => NOW, log: (line) => lines.push(line) },
    )
    expect(exit).toBe(0)
    expect(lines.filter((line) => line.startsWith("would delete"))).toHaveLength(2)
  })

  it("exits non-zero on invalid arguments", async () => {
    const invalid = [
      [],
      ["bogus"],
      ["evict", "--older-than", "0", "--keep", "1"],
      ["evict", "--older-than", "7", "--keep", "x"],
      ["evict", "--older-than", "7"],
      ["evict", "--older-than", "7", "--keep", "1", "--bogus"],
    ]
    for (const argv of invalid) {
      const lines: string[] = []
      expect(await runEvictCli(argv, {}, { log: (line) => lines.push(line) }), argv.join(" "))
        .not.toBe(0)
      expect(lines.some((line) => line.startsWith("error:"))).toBe(true)
    }
  })

  it("prints usage for --help and exits zero", async () => {
    const lines: string[] = []
    const exit = await runEvictCli(["--help"], {}, { log: (line) => lines.push(line) })
    expect(exit).toBe(0)
    expect(lines.join("\n")).toContain("usage: artifacts evict")
  })
})

describe("artifact eviction planner", () => {
  it("uses a strictly older-than cutoff", () => {
    const meta = (id: string, createdAt: string): ArtifactMeta => ({
      id,
      createdAt,
      title: id,
      bytes: 1,
    })
    const boundary = new Date(NOW - 7 * DAY_MS).toISOString()
    const over = new Date(NOW - 7 * DAY_MS - 1).toISOString()
    const plan = planEviction(
      [meta("at", boundary), meta("over", over)],
      NOW,
      { olderThanDays: 7, keep: 0 },
    )
    expect(plan.remove.map((item) => item.id)).toEqual(["over"])
  })
})
