import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryStore } from "@openchat/memory-store"
import { runMemoryTool } from "../src/tools"
import type { ToolDeps } from "../src/tools"
import type { ToolCallResult } from "../src/mcp"
import { notifyChanged, notifyConfigured, notifyUrl } from "../src/notify"

const dirs: string[] = []
let clock = Date.parse("2026-02-01T00:00:00.000Z")

function deps(notified: () => Promise<boolean> = async () => true): ToolDeps {
  const dir = mkdtempSync(join(tmpdir(), "memory-tool-"))
  dirs.push(dir)
  clock = Date.parse("2026-02-01T00:00:00.000Z")
  return { store: new MemoryStore({ dir, now: () => clock }), notify: notified }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function parse(result: ToolCallResult): Record<string, unknown> {
  return JSON.parse(result.text) as Record<string, unknown>
}

describe("memory MCP tools", () => {
  it("mem_index returns a compact bounded index", async () => {
    const result = await runMemoryTool("mem_index", {}, deps())
    expect(result.isError).toBe(false)
    expect(result.text).not.toContain("\n  ")
    expect(parse(result)).toMatchObject({ tokens: expect.any(Number) })
    expect(String(parse(result).index)).toContain("# Memory index")
  })

  it("mem_write writes a batch and rejects a secret with a stable code", async () => {
    const d = deps()
    const result = await runMemoryTool(
      "mem_write",
      {
        entries: [
          { text: "Prefers dark mode", topic: "preferences", trust: "explicit" },
          { text: "token = sk-abcdefghijklmnopqrstuvwx", topic: "x" },
        ],
      },
      d,
    )
    const body = parse(result)
    const results = body.results as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({ ok: true })
    expect(results[1]).toMatchObject({ ok: false, code: "secret" })
    expect(body.notified).toBe(true)
    expect(await d.store.list()).toHaveLength(1)
  })

  it("mem_write returns duplicateOf for near-identical active facts", async () => {
    const d = deps()
    await runMemoryTool("mem_write", { entries: [{ text: "Likes oolong tea", topic: "taste" }] }, d)
    const second = parse(
      await runMemoryTool("mem_write", { entries: [{ text: "likes oolong tea", topic: "taste" }] }, d),
    )
    const results = second.results as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({ ok: false, code: "duplicate" })
    expect(String(results[0]?.duplicateOf)).toMatch(/^f_/)
  })

  it("mem_find ranks matches and excludes superseded facts", async () => {
    const d = deps()
    const write = await runMemoryTool(
      "mem_write",
      {
        entries: [
          { text: "Prefers German UI and English docs", topic: "preferences", trust: "explicit" },
          { text: "Project uses Hono", topic: "projects", trust: "observed" },
        ],
      },
      d,
    )
    const firstId = ((parse(write).results as Array<Record<string, unknown>>)[0] as { id: string }).id
    clock += 1000
    await runMemoryTool("mem_write", { entries: [{ text: "Prefers French UI", topic: "preferences" }] }, d)
    const found = parse(
      await runMemoryTool("mem_find", { queries: ["german", "hono"], limit: 10 }, d),
    )
    const rows = found.results as Array<Record<string, unknown>>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => row.id === firstId)).toBe(false)
    expect(rows.some((row) => String(row.text).includes("Hono"))).toBe(true)
  })

  it("mem_get fetches chosen ids including superseded records", async () => {
    const d = deps()
    const write = await runMemoryTool("mem_write", { entries: [{ text: "Old note", topic: "x" }] }, d)
    const id = ((parse(write).results as Array<Record<string, unknown>>)[0] as { id: string }).id
    await runMemoryTool("mem_delete", { ids: [id], reason: "wrong" }, d)
    const full = parse(await runMemoryTool("mem_get", { ids: [id] }, d))
    expect((full.results as Array<Record<string, unknown>>)[0]).toMatchObject({ id, status: "deleted" })
    const picked = parse(await runMemoryTool("mem_get", { ids: [id], fields: ["id", "status"] }, d))
    expect((picked.results as Array<Record<string, unknown>>)[0]).toEqual({ id, status: "deleted" })
  })

  it("mem_update applies confirm and changes status", async () => {
    const d = deps()
    const write = await runMemoryTool("mem_write", { entries: [{ text: "Uses Vim", topic: "x" }] }, d)
    const id = ((parse(write).results as Array<Record<string, unknown>>)[0] as { id: string }).id
    const updated = parse(await runMemoryTool("mem_update", { updates: [{ id, confirm: true, status: "expired" }] }, d))
    expect((updated.results as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: true, status: "expired" })
    expect(await d.store.index()).not.toContain("Uses Vim")
  })

  it("mem_prune preview never deletes; apply needs dryRun false", async () => {
    const d = deps()
    await runMemoryTool("mem_write", { entries: [{ text: "Will be stale", topic: "x" }] }, d)
    const preview = parse(await runMemoryTool("mem_prune", { dryRun: true, maxAgeDays: 0 }, d))
    expect(preview.dryRun).toBe(true)
    expect((preview.candidates as unknown[]).length).toBe(1)
    expect(await d.store.list()).toHaveLength(1)
    const applied = parse(await runMemoryTool("mem_prune", { dryRun: false, maxAgeDays: 0 }, d))
    expect(applied.dryRun).toBe(false)
    expect(await d.store.list()).toHaveLength(0)
  })

  it("mem_stats and batch-shape validation", async () => {
    const d = deps()
    expect(parse(await runMemoryTool("mem_stats", {}, d))).toMatchObject({ total: 0, active: 0 })
    expect((await runMemoryTool("mem_find", { queries: "not-an-array" }, d)).isError).toBe(true)
    expect((await runMemoryTool("mem_write", { entries: {} }, d)).isError).toBe(true)
    expect((await runMemoryTool("mem_delete", { ids: ["f_x"] }, d)).isError).toBe(true)
  })

  it("tolerates a failed notification without failing the write", async () => {
    const d = deps(async () => false)
    const result = await runMemoryTool("mem_write", { entries: [{ text: "Fact after outage", topic: "x" }] }, d)
    expect(result.isError).toBe(false)
    expect(parse(result).notified).toBe(false)
    expect(await d.store.list()).toHaveLength(1)
  })
})

describe("notification helper", () => {
  it("only posts when both configuration halves are set and swallows failures", async () => {
    expect(notifyConfigured({ bffUrl: "", token: "x" })).toBe(false)
    expect(notifyConfigured({ bffUrl: "http://localhost:8787", token: "" })).toBe(false)
    expect(notifyUrl("http://localhost:8787/")).toBe("http://localhost:8787/internal/memory/changed")
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"))
    const ok = await notifyChanged({
      bffUrl: "http://localhost:8787",
      token: "secret",
      fetch: fetchMock,
    })
    expect(ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
