import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_PROTOCOL_VERSION,
  FALLBACK_VERSION,
  SERVER_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleRpc,
  readManifestVersion,
  serveStdio,
} from "../src/mcp"
import type { ToolHandler } from "../src/mcp"
import { DOCUMENT_TOOLS } from "../src/tools"

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manifestDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "python-tool-version-"))
  created.push(dir)
  writeFileSync(join(dir, "package.json"), contents)
  return dir
}

const call: ToolHandler = async () => ({ text: "ok", isError: false })

function rpc(method: string, id: number | string | undefined = 1, params?: unknown) {
  return { jsonrpc: "2.0", id, method, params }
}

describe("MCP: initialize", () => {
  it("echoes a supported protocol version", async () => {
    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "2025-03-26" }), DOCUMENT_TOOLS, call)
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
    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "1999-01-01" }), DOCUMENT_TOOLS, call)
    expect(response).toMatchObject({ result: { protocolVersion: DEFAULT_PROTOCOL_VERSION } })
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(DEFAULT_PROTOCOL_VERSION)
  })

  it("answers ping with an empty result", async () => {
    expect(await handleRpc(rpc("ping"), DOCUMENT_TOOLS, call)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    })
  })
})

describe("MCP: server version", () => {
  it("reports the package version from its own manifest", async () => {
    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "2025-06-18" }), DOCUMENT_TOOLS, call)
    const result = (response as { result?: { serverInfo?: { version?: string } } } | null)?.result
    expect(result?.serverInfo?.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("falls back when the manifest is unreadable or has no version", () => {
    const dir = manifestDir('{\n  "name": "@openchat/python-tool"\n}\n')
    expect(readManifestVersion(pathToFileURL(join(dir, "package.json")))).toBe(FALLBACK_VERSION)
    expect(readManifestVersion(pathToFileURL(join(dir, "missing.json")))).toBe(FALLBACK_VERSION)
  })
})

describe("MCP: tools", () => {
  it("lists the four document tools", async () => {
    const response = await handleRpc(rpc("tools/list"), DOCUMENT_TOOLS, call)
    const result = (response as { result?: unknown } | null)?.result as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>
    }
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "docx_fill",
      "xlsx_write",
      "pdf_from_markdown",
      "read_document",
    ])
    expect(result.tools[0]?.inputSchema.required).toEqual(["title"])
  })

  it("passes the tool name and arguments through", async () => {
    const seen: unknown[] = []
    const response = await handleRpc(
      rpc("tools/call", 7, { name: "read_document", arguments: { name: "a.pdf" } }),
      DOCUMENT_TOOLS,
      async (name, args) => {
        seen.push([name, args])
        return { text: "read it", isError: false }
      },
    )
    expect(seen).toEqual([["read_document", { name: "a.pdf" }]])
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "read it" }] },
    })
  })

  it("marks a tool error as isError", async () => {
    const response = await handleRpc(
      rpc("tools/call", 3, { name: "docx_fill", arguments: {} }),
      DOCUMENT_TOOLS,
      async () => ({ text: "bad input", isError: true }),
    )
    expect(response).toMatchObject({ result: { isError: true } })
  })

  it("rejects an unknown tool and an unknown method", async () => {
    expect(await handleRpc(rpc("tools/call", 3, { name: "other" }), DOCUMENT_TOOLS, call)).toMatchObject({
      error: { code: -32602 },
    })
    expect(await handleRpc(rpc("resources/list"), DOCUMENT_TOOLS, call)).toMatchObject({
      error: { code: -32601, message: "Method not found" },
    })
  })

  it("survives a throwing handler", async () => {
    const response = await handleRpc(
      rpc("tools/call", 3, { name: "docx_fill" }),
      DOCUMENT_TOOLS,
      async () => {
        throw new Error("boom")
      },
    )
    expect(response).toMatchObject({ result: { isError: true } })
  })
})

describe("MCP: protocol edges", () => {
  it("answers a notification with nothing", async () => {
    expect(
      await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, DOCUMENT_TOOLS, call),
    ).toBeNull()
  })

  it("answers a non-object message with a parse error", async () => {
    expect(await handleRpc("hello", DOCUMENT_TOOLS, call)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    })
  })

  it("answers a message without a method as invalid", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", id: 4 }, DOCUMENT_TOOLS, call)).toMatchObject({
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
    await serveStdio({
      input: Readable.from([`${lines.join("\n")}\n`]),
      output,
      tools: DOCUMENT_TOOLS,
      call,
    })
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
      tools: DOCUMENT_TOOLS,
      call,
    })
    const answers = text().trim().split("\n").map((line) => JSON.parse(line) as unknown)
    expect(answers[0]).toMatchObject({ id: null, error: { code: -32700 } })
    expect(answers[1]).toMatchObject({ id: 9, result: {} })
  })
})
