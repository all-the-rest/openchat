import { Readable, Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_PROTOCOL_VERSION,
  SERVER_NAME,
  handleRpc,
  readManifestVersion,
  serveStdio,
} from "../src/mcp"
import type { ToolHandler } from "../src/mcp"
import { MEMORY_TOOLS } from "../src/tools"

const call: ToolHandler = async () => ({ text: '{"ok":true}', isError: false })

function rpc(method: string, id: number | string | undefined = 1, params?: unknown) {
  return { jsonrpc: "2.0", id, method, params }
}

describe("memory MCP: protocol", () => {
  it("initializes with the server name and negotiated version", async () => {
    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "2025-03-26" }), call)
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: readManifestVersion() },
      },
    })
    expect(DEFAULT_PROTOCOL_VERSION).toBe("2025-06-18")
  })

  it("lists all eight batch tools", async () => {
    const response = await handleRpc(rpc("tools/list"), call)
    const tools = (response as { result: { tools: Array<{ name: string }> } }).result.tools
    expect(tools.map((tool) => tool.name)).toEqual([
      "mem_index",
      "mem_find",
      "mem_update",
      "mem_write",
      "mem_get",
      "mem_delete",
      "mem_prune",
      "mem_stats",
    ])
    expect(MEMORY_TOOLS).toHaveLength(8)
  })

  it("passes the tool name and arguments through", async () => {
    const seen: unknown[] = []
    const response = await handleRpc(
      rpc("tools/call", 7, { name: "mem_find", arguments: { queries: ["caddy"] } }),
      async (name, args) => {
        seen.push([name, args])
        return { text: "result", isError: false }
      },
    )
    expect(seen).toEqual([["mem_find", { queries: ["caddy"] }]])
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "result" }] },
    })
  })

  it("marks a tool error as isError and never answers a notification", async () => {
    const response = await handleRpc(
      rpc("tools/call", 2, { name: "mem_stats", arguments: {} }),
      async () => ({ text: "boom", isError: true }),
    )
    expect(response).toMatchObject({ result: { isError: true } })
    expect(await handleRpc({ jsonrpc: "2.0", method: "tools/call" }, call)).toBeNull()
  })

  it("reads newline-delimited messages and survives a malformed line", async () => {
    const input = Readable.from([
      "{not json}\n",
      `${JSON.stringify(rpc("ping", 2))}\n`,
    ])
    let output = ""
    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    await serveStdio({ input, output: writable, call })
    const lines = output.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ error: { code: -32700 } })
    expect(JSON.parse(lines[1] ?? "")).toEqual({ jsonrpc: "2.0", id: 2, result: {} })
  })
})
