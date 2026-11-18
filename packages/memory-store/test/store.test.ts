import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FACTS_FILE, INDEX_FILE, MemoryStore } from "../src/index"

const dirs: string[] = []
let clock = new Date("2026-11-18T10:00:00.000Z")

async function store(options: { maxEntryBytes?: number; maxTotalBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openchat-memory-store-"))
  dirs.push(dir)
  clock = new Date("2026-11-18T10:00:00.000Z")
  return new MemoryStore({ dir, now: () => clock, ...options })
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("memory store: files and writes", () => {
  it("writes one 0600 JSONL line, a 0600 index and a 0700 directory", async () => {
    const memory = await store()
    const [result] = await memory.write(
      [{ text: "Prefers German UI and English docs.", topic: "preference.language", trust: "explicit" }],
      "owner",
    )
    expect(result?.ok).toBe(true)
    if (!result?.ok) return

    const facts = await readFile(join(memory.dir, FACTS_FILE), "utf8")
    expect(facts.split("\n").filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(facts) as unknown).toMatchObject({
      id: result.fact.id,
      text: "Prefers German UI and English docs.",
      topic: "preference.language",
      trust: "explicit",
      status: "active",
      supersedes: [],
    })
    expect((await stat(join(memory.dir, FACTS_FILE))).mode & 0o777).toBe(0o600)
    expect((await stat(join(memory.dir, INDEX_FILE))).mode & 0o777).toBe(0o600)
    expect((await stat(memory.dir)).mode & 0o777).toBe(0o700)
    expect((await memory.list())).toHaveLength(1)
  })

  it("serialises concurrent writers without losing a fact", async () => {
    const memory = await store()
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]
    await Promise.all(
      words.map((word) =>
        memory.write([{ text: `Concurrent fact about ${word}`, topic: `t${word}` }]),
      ),
    )
    expect(await memory.facts()).toHaveLength(12)
  })

  it("keeps a corrupt line from hiding the rest of the store", async () => {
    const memory = await store()
    await memory.write([{ text: "A good fact about the workspace", topic: "project" }])
    const path = join(memory.dir, FACTS_FILE)
    const original = await readFile(path, "utf8")
    await writeFile(path, `${original}{"not":"a fact"}\n`, { mode: 0o600 })
    expect(await memory.facts()).toHaveLength(1)
  })

  it("enforces the per-entry and total byte caps", async () => {
    const memory = await store({ maxEntryBytes: 32, maxTotalBytes: 900 })
    const large = await memory.write([{ text: "x".repeat(40), topic: "big" }])
    expect(large[0]).toMatchObject({ ok: false, code: "memory_too_large" })

    const results = []
    for (let index = 0; index < 20; index += 1) {
      const [written] = await memory.write([
        { text: `Fact ${index} ${"y".repeat(20)}`, topic: `topic${index}` },
      ])
      results.push(written)
    }
    expect(results.some((entry) => entry?.ok === false && entry.code === "memory_store_full")).toBe(true)
  })
})

describe("memory store: status and cleanup", () => {
  it("supersedes without overwriting and links both rows", async () => {
    const memory = await store()
    const [first] = await memory.write(
      [{ text: "Uses the pnpm workspace layout", topic: "project.openchat", trust: "explicit" }],
      "owner",
    )
    if (!first?.ok) throw new Error("first write failed")
    const [second] = await memory.write([
      {
        text: "Uses pnpm workspaces with catalog versions",
        topic: "project.openchat",
        trust: "explicit",
        supersedes: [first.fact.id],
      },
    ])
    expect(second?.ok).toBe(true)

    const all = await memory.get([first.fact.id, second?.ok === true ? second.fact.id : ""])
    expect(all.map((fact) => fact.status).sort()).toEqual(["active", "superseded"])
    expect(all.find((fact) => fact.id === first.fact.id)?.status).toBe("superseded")

    const found = await memory.find("pnpm catalogs")
    expect(found.map((fact) => fact.id)).not.toContain(first.fact.id)
    expect(await memory.readIndex()).not.toContain(first.fact.id)
  })

  it("soft-deletes and keeps an append-only audit", async () => {
    const memory = await store()
    const [written] = await memory.write([{ text: "Temporary fact about a test", topic: "test" }])
    if (!written?.ok) throw new Error("write failed")
    await memory.delete([written.fact.id], "no longer true", "owner")

    expect(await memory.list()).toEqual([])
    expect((await memory.get([written.fact.id]))[0]?.status).toBe("deleted")
    const audit = await memory.audit(10)
    expect(audit.at(-1)).toMatchObject({
      actor: "owner",
      action: "delete",
      ids: [written.fact.id],
      reason: "no longer true",
    })
  })

  it("prunes only on apply, and names the reason", async () => {
    const memory = await store()
    const [expired] = await memory.write([
      {
        text: "An old observed preference",
        topic: "preference.old",
        expiresAt: "2026-11-01T00:00:00.000Z",
      },
    ])
    if (!expired?.ok) throw new Error("write failed")

    const dry = await memory.prune({ superseded: false })
    expect(dry.dryRun).toBe(true)
    expect(dry.candidates).toEqual([
      expect.objectContaining({ id: expired.fact.id, reason: "stale" }),
    ])
    expect(dry.deleted).toEqual([])
    expect((await memory.get([expired.fact.id]))[0]?.status).toBe("active")

    const applied = await memory.prune({ dryRun: false, superseded: false })
    expect(applied.deleted).toEqual([expired.fact.id])
    expect((await memory.get([expired.fact.id]))[0]?.status).toBe("deleted")
    expect((await memory.audit(5)).at(-1)).toMatchObject({
      action: "prune",
      reason: "prune:stale",
    })
  })

  it("finds by keyword, topic and tag with expired rows excluded", async () => {
    const memory = await store()
    await memory.write([
      { text: "The deployment runs on Hetzner with Caddy", topic: "project.deploy", tags: ["hosting"] },
      { text: "Prefers concise commit messages", topic: "preference.commits", tags: ["git"] },
    ])
    expect((await memory.find("caddy")).map((fact) => fact.topic)).toEqual(["project.deploy"])
    expect((await memory.find("deploy")).map((fact) => fact.topic)).toEqual(["project.deploy"])
    expect(await memory.find("caddy", { tags: ["git"] })).toEqual([])

    clock = new Date("2027-11-18T10:00:00.000Z")
    expect(await memory.find("caddy")).toEqual([])
  })
})

describe("memory store: stats", () => {
  it("reports counts, topics and caps", async () => {
    const memory = await store({ maxTotalBytes: 1_000, maxEntryBytes: 100 })
    await memory.write([{ text: "Likes dark mode", topic: "preference.theme", trust: "explicit" }])
    const stats = await memory.stats()
    expect(stats).toMatchObject({
      total: 1,
      active: 1,
      deleted: 0,
      totalBytesCap: 1_000,
      entryBytesCap: 100,
      topics: ["preference.theme"],
    })
    expect(stats.indexChars).toBeGreaterThan(0)
  })
})
