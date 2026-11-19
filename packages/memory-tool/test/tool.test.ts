import type { MemoryOp } from "@openchat/contracts"
import { describe, expect, it } from "vitest"
import { buildMemoryOp, callMemoryTool } from "../src/tool"
import type { FetchLike } from "../src/bff"

const TOKEN = "test-token"

function record(): { fetch: FetchLike; bodies: unknown[] } {
  const bodies: unknown[] = []
  const fetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init.body)) as unknown)
    return new Response('{"ok":true}', { status: 200 })
  }
  return { fetch, bodies }
}

describe("tool to op mapping", () => {
  it.each([
    ["mem_index", {}, { op: "index" }],
    ["mem_find", { queries: ["q"], tags: ["t"], limit: 3 }, { op: "find", queries: ["q"], tags: ["t"], limit: 3 }],
    ["mem_get", { ids: ["m1"], fields: ["text"] }, { op: "get", ids: ["m1"], fields: ["text"] }],
    [
      "mem_write",
      { entries: [{ kind: "preference", text: "t", topic: "food" }] },
      { op: "write", inputs: [{ kind: "preference", text: "t", topic: "food" }], actor: "agent" },
    ],
    ["mem_update", { updates: [{ id: "m1", status: "superseded" }] }, { op: "update", updates: [{ id: "m1", status: "superseded" }], actor: "agent" }],
    ["mem_delete", { ids: ["m1"], reason: "stale" }, { op: "delete", ids: ["m1"], reason: "stale", actor: "agent" }],
    ["mem_prune", { dryRun: true, maxAgeDays: 90 }, { op: "prune", dryRun: true, maxAgeDays: 90, actor: "agent" }],
    ["mem_stats", {}, { op: "stats" }],
  ])("maps %s to its internal op", async (name, args, expected) => {
    const { fetch, bodies } = record()
    const result = await callMemoryTool(name, args, {
      bffUrl: "http://bff:8787",
      token: TOKEN,
      fetch,
    })
    expect(result).toEqual({ ok: true, result: { ok: true } })
    expect(bodies).toEqual([expected])
    expect(buildMemoryOp(name, args)).toEqual(expected as unknown as MemoryOp)
  })

  it("cannot be redirected by a stray op argument", () => {
    expect(buildMemoryOp("mem_find", { op: "delete", queries: ["q"] })).toEqual({
      op: "find",
      queries: ["q"],
    })
  })

  it("cannot be spoofed by a stray actor argument on a mutating op", () => {
    expect(buildMemoryOp("mem_delete", { ids: ["m1"], reason: "stale", actor: "owner" })).toEqual({
      op: "delete",
      ids: ["m1"],
      reason: "stale",
      actor: "agent",
    })
  })

  it("refuses an unknown tool before any request", async () => {
    const { fetch, bodies } = record()
    const result = await callMemoryTool("mem_drop_all", {}, { bffUrl: "http://bff", token: TOKEN, fetch })
    expect(result.ok).toBe(false)
    expect(bodies).toEqual([])
  })

  it("propagates the BFF error line", async () => {
    const fetch: FetchLike = async () => new Response("denied", { status: 401 })
    const result = await callMemoryTool("mem_stats", {}, { bffUrl: "http://bff", token: TOKEN, fetch })
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).toContain("MEMORY_INTERNAL_TOKEN")
    expect(JSON.stringify(result)).not.toContain("denied")
  })
})
