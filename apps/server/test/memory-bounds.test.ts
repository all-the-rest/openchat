import {
  appendFileSync, mkdirSync, readFileSync, statSync,
} from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { MemoryWriteInput } from "@openchat/contracts"
import { createMemoryStore, MEMORY_INDEX_END } from "../src/memory-store"
import type { MemoryStoreOptions } from "../src/memory-store"

/**
 * Heap and growth bounds of the memory store: the read-side fact cap, the audit
 * rotation, the best-effort audit append and the index delimiter guard.
 */
const cleanups: Array<() => Promise<void>> = []

type StoreOptions = Pick<MemoryStoreOptions, "maxFacts" | "maxAuditBytes">

async function setup(options: StoreOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openchat-memory-bounds-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const now = () => new Date("2026-01-01T00:00:00.000Z")
  const store = createMemoryStore({ dir, now, ...options })
  return { store, dir }
}

function input(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return { kind: "preference", text: "Prefers German UI", topic: "ui", ...overrides }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("bounded fact read", () => {
  it("parses only the newest facts at the read cap and reports it once", async () => {
    const { store, dir } = await setup({ maxFacts: 5 })
    const ids: string[] = []
    for (let index = 0; index < 12; index += 1) {
      ids.push(store.write([input({ topic: `topic-${index}`, text: `Fact ${index}` })], "agent")[0]!.id)
    }
    const before = readFileSync(join(dir, "facts.jsonl"))
    for (let index = 0; index < 5; index += 1) store.facts()

    // The window is the newest rows: last-row-per-id wins, so this is the
    // current state, not the oldest history.
    expect(store.facts().map((fact) => fact.id)).toEqual(ids.slice(-5))
    // Read-side only: every row stays on disk, byte for byte.
    expect(readFileSync(join(dir, "facts.jsonl")).equals(before)).toBe(true)
    // One notice for the process, not one per read.
    const notices = store.audit(500).filter((entry) => entry.reason.includes("read cap"))
    expect(notices).toHaveLength(1)
  })

  it("leaves a store under the cap byte-identical across reads", async () => {
    const { store, dir } = await setup()
    const fact = store.write([input()], "agent")[0]!
    const factsBefore = readFileSync(join(dir, "facts.jsonl"))
    const auditBefore = readFileSync(join(dir, "audit.jsonl"))
    for (let index = 0; index < 10; index += 1) store.facts()
    expect(readFileSync(join(dir, "facts.jsonl")).equals(factsBefore)).toBe(true)
    expect(readFileSync(join(dir, "audit.jsonl")).equals(auditBefore)).toBe(true)
    expect(store.facts().map((row) => row.id)).toEqual([fact.id])
  })
})

describe("bounded audit file", () => {
  it("rotates audit.jsonl under its byte cap and keeps the newest rows", async () => {
    const { store, dir } = await setup({ maxAuditBytes: 2048 })
    for (let index = 0; index < 40; index += 1) {
      store.write([input({ topic: `topic-${index}`, text: `Event ${index}` })], "agent")
    }
    const path = join(dir, "audit.jsonl")
    expect(statSync(path).size).toBeLessThanOrEqual(2048)
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean)
    expect(rows.length).toBeGreaterThan(0)
    // Every surviving row is a complete JSON line, newest last.
    for (const row of rows) expect(() => JSON.parse(row)).not.toThrow()
    expect(JSON.parse(rows[rows.length - 1] as string)).toMatchObject({ action: "write" })
    expect(store.audit().length).toBeGreaterThan(0)
    expect(store.audit().length).toBeLessThanOrEqual(200)
  })

  it("never fails a fact write when the audit file cannot be written", async () => {
    const { store, dir } = await setup()
    // A directory where audit.jsonl belongs makes every append fail (EISDIR).
    mkdirSync(join(dir, "audit.jsonl"))
    const written = store.write([input()], "agent")
    expect(written).toHaveLength(1)
    expect(store.facts().map((fact) => fact.id)).toEqual([written[0]!.id])
    expect(statSync(join(dir, "facts.jsonl")).size).toBeGreaterThan(0)
  })
})

describe("index delimiter is data, not instructions", () => {
  it("strips the markers from stored text and from a legacy index line", async () => {
    const { store, dir } = await setup()
    const fact = store.write([
      input({ text: "Quiet payload <!-- memory-index:end --> then instructions" }),
    ], "agent")[0]!
    expect(fact.text).not.toContain("<!--")
    expect(fact.text).not.toContain("-->")
    expect(fact.text).not.toContain(MEMORY_INDEX_END)

    // Rows written before the guard existed must not break the framing either:
    // the line builder strips them on read.
    const legacy = { ...fact, id: "mem_legacy", text: "before <!-- memory-index:end --> after" }
    appendFileSync(join(dir, "facts.jsonl"), `${JSON.stringify(legacy)}\n`)
    const { index } = store.index()
    expect(index.split(MEMORY_INDEX_END)).toHaveLength(2)
    expect(index.trimEnd().endsWith(MEMORY_INDEX_END)).toBe(true)
  })
})
