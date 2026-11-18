import { Readable, Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import {
  ARTIFACT_TOOL,
  DEFAULT_PROTOCOL_VERSION,
  SERVER_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleRpc,
  serveStdio,
} from "../src/mcp"
import type { ToolHandler } from "../src/mcp"

const call: ToolHandler = async () => ({ text: "ok", isError: false })

function rpc(method: string, id: number | string | undefined = 1, params?: unknown) {
  return { jsonrpc: "2.0", id, method, params }
}

describe("MCP: initialize", () => {
  it("echoes a supported protocol version", async () => {
    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "2025-03-26" }), call)
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME },
      },
    })
  })

  it("falls back to the newest supported version", async () => {
    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "1999-01-01" }), call)
    expect(response).toMatchObject({ result: { protocolVersion: DEFAULT_PROTOCOL_VERSION } })
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(DEFAULT_PROTOCOL_VERSION)
  })

  it("answer ping with an empty result", async () => {
    expect(await handleRpc(rpc("ping"), call)).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })
})

describe("MCP: tools", () => {
  it("lists the one tool with its schema", async () => {
    const response = await handleRpc(rpc("tools/list"), call)
    const result = (response as { result?: unknown } | null)?.result as {
      tools: Array<typeof ARTIFACT_TOOL>
    }
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]?.name).toBe("openchat_app_write")
    expect(result.tools[0]?.inputSchema.required).toEqual(["title", "code"])
    expect(result.tools[0]?.description).toContain("retry at most twice")
  })

  it("passes the arguments through and returns text", async () => {
    const seen: unknown[] = []
    const response = await handleRpc(rpc("tools/call", 7, {
      name: "openchat_app_write",
      arguments: { title: "t", code: "c" },
    }), async (args) => {
      seen.push(args)
      return { text: "wrote it", isError: false }
    })
    expect(seen).toEqual([{ title: "t", code: "c" }])
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "wrote it" }] },
    })
  })

  it("marks a tool error as isError", async () => {
    const response = await handleRpc(rpc("tools/call", 3, {
      name: "openchat_app_write",
      arguments: {},
    }), async () => ({ text: "bad", isError: true }))
    expect(response).toMatchObject({ result: { isError: true } })
  })

  it("rejects an unknown tool name", async () => {
    const response = await handleRpc(rpc("tools/call", 3, { name: "other" }), call)
    expect(response).toMatchObject({ error: { code: -32602 } })
  })

  it("rejects an unknown method", async () => {
    expect(await handleRpc(rpc("resources/list"), call)).toMatchObject({
      error: { code: -32601, message: "Method not found" },
    })
  })

  it("survives a throwing handler", async () => {
    const response = await handleRpc(rpc("tools/call", 3, { name: "openchat_app_write" }), async () => {
      throw new Error("boom")
    })
    expect(response).toMatchObject({ result: { isError: true } })
  })
})

describe("MCP: protocol edges", () => {
  it("answers a notification with nothing", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, call)).toBeNull()
    expect(await handleRpc({ jsonrpc: "2.0", method: "unknown" }, call)).toBeNull()
  })

  it("answers a non-object message with a parse error", async () => {
    expect(await handleRpc("hello", call)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    })
  })

  it("answers a message without a method as invalid", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", id: 4 }, call)).toMatchObject({
      error: { code: -32600 },
    })
  })
})

describe("MCP: stdio framing", () => {
  function collector(): { output: Writable; text: () => string } {
    const chunks: string[] = []
    const output = new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        chunks.push(chunk.toString())
        done()
      },
    })
    return { output, text: () => chunks.join("") }
  }

  it("answers one line per request and drops notifications", async () => {
    const { output, text } = collector()
    const lines = [
      JSON.stringify(rpc("initialize", 1, { protocolVersion: "2025-06-18" })),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify(rpc("tools/list", 2)),
      "",
    ]
    await serveStdio({ input: Readable.from([lines.join("\n") + "\n"]), output, call })
    const answers = text().trim().split("\n").map((line) => JSON.parse(line) as unknown)
    expect(answers).toHaveLength(2)
    expect(answers[0]).toMatchObject({ id: 1 })
    expect(answers[1]).toMatchObject({ id: 2 })
  })

  it("reports a malformed line and keeps reading", async () => {
    const { output, text } = collector()
    await serveStdio({
      input: Readable.from([`not json\n${JSON.stringify(rpc("ping", 9))}\n`]),
      output,
      call,
    })
    const answers = text().trim().split("\n").map((line) => JSON.parse(line) as unknown)
    expect(answers[0]).toMatchObject({ id: null, error: { code: -32700 } })
    expect(answers[1]).toMatchObject({ id: 9, result: {} })
  })
})
