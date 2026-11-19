import { describe, expect, it } from "vitest"
import { handleRpc, MEMORY_TOOLS, TOOL_NAMES } from "../src/mcp"
import type { ToolCallResult } from "../src/mcp"

const call = async (name: string, args: unknown): Promise<ToolCallResult> => ({
  text: JSON.stringify({ name, args }),
  isError: false,
})

describe("memory MCP protocol", () => {
  it("advertises exactly the eight batch tools", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        "mem_delete",
        "mem_find",
        "mem_get",
        "mem_index",
        "mem_prune",
        "mem_stats",
        "mem_update",
        "mem_write",
      ].sort(),
    )
    expect(MEMORY_TOOLS).toHaveLength(8)
  })

  it("negotiates the protocol and lists tools", async () => {
    const init = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      call,
    )
    expect(init?.result).toMatchObject({ protocolVersion: "2024-11-05" })
    const list = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, call)
    expect((list?.result as { tools: unknown[] }).tools).toHaveLength(8)
  })

  it("calls a known tool with compact content and refuses unknown tools", async () => {
    const result = await handleRpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mem_stats", arguments: {} } },
      call,
    )
    const content = (result?.result as { content: Array<{ text: string }> }).content
    expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({ name: "mem_stats" })
    const unknown = await handleRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
      call,
    )
    expect(unknown?.error).toMatchObject({ code: -32602 })
  })

  it("ignores notifications and reports malformed messages", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "ping" }, call)).toBeNull()
    expect((await handleRpc("bad", call))?.error).toMatchObject({ code: -32700 })
  })
})
