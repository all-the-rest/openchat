import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_PROTOCOL_VERSION,
  FALLBACK_VERSION,
  MEMORY_TOOLS,
  SERVER_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleRpc,
  readManifestVersion,
  serveStdio,
} from "../src/mcp"
import type { ToolCall } from "../src/mcp"

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manifestDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-tool-version-"))
  created.push(dir)
  writeFileSync(join(dir, "package.json"), contents)
  return dir
}

const call: ToolCall = async () => ({ text: "ok", isError: false })

function rpc(method: string, id: number | string | undefined = 1, params?: unknown) {
  return { jsonrpc: "2.0", id, method, params }
}

const TOOL_NAMES = [
  "mem_index",
  "mem_find",
  "mem_get",
  "mem_write",
  "mem_update",
  "mem_delete",
  "mem_prune",
  "mem_stats",
]

describe("MCP: initialize and ping", () => {
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

  it("answers ping with an empty result", async () => {
    expect(await handleRpc(rpc("ping"), call)).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })
})

describe("MCP: server version", () => {
  it("reports the package version from its own manifest", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown }
    const expected = typeof manifest.version === "string" ? manifest.version : FALLBACK_VERSION

    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "2025-06-18" }), call)
    expect(response).toMatchObject({
      result: { serverInfo: { name: SERVER_NAME, version: expected } },
    })
  })

  it("reads the version field of a manifest that has one", () => {
    const dir = manifestDir('{\n  "name": "@openchat/memory-tool",\n  "version": "1.2.3"\n}\n')
    expect(readManifestVersion(pathToFileURL(join(dir, "package.json")))).toBe("1.2.3")
  })

  it("falls back when the version is absent or the manifest is unreadable", () => {
    const dir = manifestDir('{\n  "name": "@openchat/memory-tool"\n}\n')
    expect(readManifestVersion(pathToFileURL(join(dir, "package.json")))).toBe(FALLBACK_VERSION)
    expect(readManifestVersion(pathToFileURL(join(dir, "missing.json")))).toBe(FALLBACK_VERSION)
  })
})

describe("MCP: tools/list", () => {
  it("lists exactly eight tools with valid schemas", async () => {
    const response = await handleRpc(rpc("tools/list"), call)
    const result = (response as { result?: unknown } | null)?.result as {
      tools: Array<{
        name: string
        inputSchema: { additionalProperties: boolean; required?: string[]; type: string }
      }>
    }
    expect(result.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES)
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
    expect(result.tools.find((tool) => tool.name === "mem_find")?.inputSchema.required).toEqual([
      "queries",
    ])
    expect(result.tools.find((tool) => tool.name === "mem_delete")?.inputSchema.required).toEqual([
      "ids",
      "reason",
    ])
    expect(result.tools.find((tool) => tool.name === "mem_index")?.inputSchema.required).toBeUndefined()
  })

  it("never lists a single-item variant or a read-whole-store tool", () => {
    for (const tool of MEMORY_TOOLS) {
      expect(TOOL_NAMES).toContain(tool.name)
      expect(tool.name).not.toMatch(/single|all|list_all/)
    }
  })
})

describe("MCP: tools/call for all eight tools", () => {
  it.each(TOOL_NAMES)("dispatches %s with its arguments and returns text", async (name) => {
    const args = { marker: name }
    const seen: Array<{ name: string; args: unknown }> = []
    const response = await handleRpc(
      rpc("tools/call", 7, { name, arguments: args }),
      async (gotName, gotArgs) => {
        seen.push({ name: gotName, args: gotArgs })
        return { text: `did ${gotName}`, isError: false }
      },
    )
    expect(seen).toEqual([{ name, args }])
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: `did ${name}` }] },
    })
  })

  it("marks a tool error as isError", async () => {
    const response = await handleRpc(rpc("tools/call", 3, { name: "mem_get" }), async () => ({
      text: "internal: bad",
      isError: true,
    }))
    expect(response).toMatchObject({ result: { isError: true } })
  })

  it("rejects an unknown tool name", async () => {
    const response = await handleRpc(rpc("tools/call", 3, { name: "other" }), call)
    expect(response).toMatchObject({ error: { code: -32602 } })
  })

  it("survives a throwing handler without leaking the message", async () => {
    const response = await handleRpc(rpc("tools/call", 3, { name: "mem_index" }), async () => {
      throw new Error("secret boom")
    })
    const text = ((response as { result?: { content?: Array<{ text: string }> } })?.result?.content ?? [])
      .map((c) => c.text)
      .join("")
    expect(response).toMatchObject({ result: { isError: true } })
    expect(text).not.toContain("secret boom")
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

  it("rejects an unknown method", async () => {
    expect(await handleRpc(rpc("resources/list"), call)).toMatchObject({
      error: { code: -32601, message: "Method not found" },
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
