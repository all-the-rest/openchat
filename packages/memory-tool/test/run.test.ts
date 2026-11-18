import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { MemoryFact } from "@openchat/contracts"
import { MemoryStore } from "@openchat/memory-store"
import { runMemoryTool } from "../src/run"

const dirs: string[] = []
let clock = new Date("2026-11-18T10:00:00.000Z")

async function setup(): Promise<{ store: MemoryStore; calls: number[] }> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-memory-tool-"))
  dirs.push(dir)
  clock = new Date("2026-11-18T10:00:00.000Z")
  const store = new MemoryStore({ dir, now: () => clock })
  const calls: number[] = []
  return { store, calls }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function call(
  store: MemoryStore,
  name: string,
  args: unknown = {},
  notify?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const result = await runMemoryTool(name, args, { store, notify })
  expect(result.isError).toBe(false)
  return JSON.parse(result.text) as Record<string, unknown>
}

async function write(
  store: MemoryStore,
  text: string,
  topic: string,
  extra: Record<string, unknown> = {},
): Promise<MemoryFact> {
  const body = await call(store, "mem_write", { entries: [{ text, topic, ...extra }] })
  const results = body.results as Array<{ ok: boolean; id?: string }>
  const id = results[0]?.id
  if (!id) throw new Error(`write failed: ${JSON.stringify(body)}`)
  return (await store.get([id]))[0] as MemoryFact
}

describe("memory tools: write and read", () => {
  it("accepts a batch and returns one compact result per entry", async () => {
    const { store } = await setup()
    const body = await call(store, "mem_write", {
      entries: [
        { text: "Prefers German UI", topic: "preference.language", trust: "explicit" },
        { text: "Deploys with Caddy", topic: "project.deploy", tags: ["hosting"] },
      ],
    })
    const results = body.results as Array<{ ok: boolean; id: string }>
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(await store.facts()).toHaveLength(2)
  })

  it("rejects a secret without storing it", async () => {
    const { store } = await setup()
    const body = await call(store, "mem_write", {
      entries: [{ text: "API token is sk-abcdefghijklmnop1234", topic: "secret" }],
    })
    expect((body.results as Array<{ code: string }>)[0]).toMatchObject({
      ok: false,
      code: "memory_secret_rejected",
    })
    expect(await store.facts()).toEqual([])
  })

  it("rejects a near-identical fact and names the duplicate", async () => {
    const { store } = await setup()
    const first = await write(store, "Prefers German UI and English docs", "preference")
    const body = await call(store, "mem_write", {
      entries: [{ text: "Prefers German UI and English docs", topic: "preference" }],
    })
    expect((body.results as Array<{ duplicateOf?: string }>)[0]?.duplicateOf).toBe(first.id)
  })

  it("finds by query with inactive rows excluded, then gets them by id", async () => {
    const { store } = await setup()
    const old = await write(store, "Deploys on Hetzner", "project.deploy", { trust: "explicit" })
    await write(store, "Deploys on Hetzner with Caddy", "project.deploy", {
      trust: "explicit",
      supersedes: [old.id],
    })
    const found = await call(store, "mem_find", { queries: ["hetzner", "caddy"] })
    const rows = found.results as Array<{ query: string; matches: Array<{ id: string }> }>
    expect(rows[0]?.matches.map((row) => row.id)).not.toContain(old.id)
    expect(rows[1]?.matches).toHaveLength(1)

    const got = await call(store, "mem_get", { ids: [old.id], fields: ["id", "status", "text"] })
    expect((got.facts as Array<Record<string, unknown>>)[0]).toEqual({
      id: old.id,
      status: "superseded",
      text: "Deploys on Hetzner",
    })
  })

  it("filters by tag and since", async () => {
    const { store } = await setup()
    await write(store, "Uses pnpm", "project.build", { tags: ["tooling"] })
    await write(store, "Uses Caddy", "project.deploy", { tags: ["hosting"] })
    const tagged = await call(store, "mem_find", { queries: ["uses"], tags: ["hosting"] })
    const rows = tagged.results as Array<{ matches: Array<{ topic: string }> }>
    expect(rows[0]?.matches.map((row) => row.topic)).toEqual(["project.deploy"])
  })
})

describe("memory tools: updates and cleanup", () => {
  it("updates in a batch and resets confirmation only explicitly", async () => {
    const { store } = await setup()
    const fact = await write(store, "Uses npm", "project.build", { trust: "explicit" })
    clock = new Date("2026-12-01T10:00:00.000Z")
    const body = await call(store, "mem_update", {
      updates: [
        { id: fact.id, text: "Uses pnpm", confirm: true },
        { id: "mem_missing00", topic: "project" },
      ],
    })
    const results = body.results as Array<{ ok: boolean; code?: string }>
    expect(results[0]?.ok).toBe(true)
    expect(results[1]).toMatchObject({ ok: false, code: "memory_not_found" })
    const updated = (await store.get([fact.id]))[0] as MemoryFact
    expect(updated.text).toBe("Uses pnpm")
    expect(updated.lastConfirmedAt).toBe("2026-12-01T10:00:00.000Z")
  })

  it("deletes in a batch with a reason", async () => {
    const { store } = await setup()
    const fact = await write(store, "An obsolete project fact", "project.old")
    const body = await call(store, "mem_delete", { ids: [fact.id], reason: "project ended" })
    expect((body.results as Array<{ ok: boolean }>)[0]?.ok).toBe(true)
    expect((await store.get([fact.id]))[0]?.status).toBe("deleted")
  })

  it("never deletes on a prune dry-run, and deletes on apply", async () => {
    const { store } = await setup()
    const fact = await write(store, "An old observed preference", "preference.old", {
      expiresAt: "2026-11-01T00:00:00.000Z",
    })
    const dry = await call(store, "mem_prune", {})
    expect(dry.dryRun).toBe(true)
    expect(dry.deleted).toEqual([])
    expect((dry.candidates as Array<{ id: string }>).map((candidate) => candidate.id)).toEqual([
      fact.id,
    ])
    expect((await store.get([fact.id]))[0]?.status).toBe("active")

    clock = new Date("2026-11-19T10:00:00.000Z")
    const applied = await call(store, "mem_prune", { dryRun: false })
    expect(applied.deleted).toEqual([fact.id])
    expect((await store.get([fact.id]))[0]?.status).toBe("deleted")
  })

  it("returns the index and stats as compact JSON", async () => {
    const { store } = await setup()
    await write(store, "Prefers concise answers", "preference.style")
    const index = await call(store, "mem_index")
    expect(index.index).toContain("Prefers concise answers")
    expect(index.chars).toBe(Number((index.index as string).length))
    const stats = await call(store, "mem_stats")
    expect(stats).toMatchObject({ total: 1, active: 1 })
  })
})

describe("memory tools: notify and validation", () => {
  it("notifies after a mutation and tolerates a notify failure", async () => {
    const { store, calls } = await setup()
    const notify = async () => {
      calls.push(1)
      throw new Error("BFF down")
    }
    const result = await runMemoryTool(
      "mem_write",
      { entries: [{ text: "Notify survives a failure", topic: "test" }] },
      { store, notify },
    )
    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(await store.facts()).toHaveLength(1)
  })

  it("does not notify on reads or a dry-run", async () => {
    const { store, calls } = await setup()
    const notify = async () => {
      calls.push(1)
    }
    await call(store, "mem_index", {}, notify)
    await call(store, "mem_prune", { dryRun: true }, notify)
    expect(calls).toEqual([])
  })

  it("turns bad arguments into a named tool error", async () => {
    const { store } = await setup()
    const result = await runMemoryTool("mem_find", { queries: [] }, { store })
    expect(result.isError).toBe(true)
    expect(result.text).toContain("queries")
    const unknown = await runMemoryTool("mem_read_all", {}, { store })
    expect(unknown.isError).toBe(true)
  })
})
