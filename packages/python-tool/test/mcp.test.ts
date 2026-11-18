import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  TOOLS,
  handleRpc,
  readManifestVersion,
  serveStdio,
} from "../src/mcp"
import type { ToolHandler } from "../src/mcp"

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const call: ToolHandler = async () => ({ text: "ok", isError: false })

function rpc(method: string, id: number | string | undefined = 1, params?: unknown) {
  return { jsonrpc: "2.0", id, method, params }
}

describe("MCP: handshake", () => {
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
  it("reads the package version from its own manifest", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown }
    const expected = typeof manifest.version === "string" ? manifest.version : FALLBACK_VERSION
    const response = await handleRpc(rpc("initialize", 1, { protocolVersion: "2025-06-18" }), call)
    expect(response).toMatchObject({
      result: { serverInfo: { name: SERVER_NAME, version: expected } },
    })
  })

  it("falls back when the manifest is absent or has no version", () => {
    const dir = mkdtempSync(join(tmpdir(), "python-tool-version-"))
    created.push(dir)
    writeFileSync(join(dir, "package.json"), '{\n  "name": "@openchat/python-tool"\n}\n')
    expect(readManifestVersion(pathToFileURL(join(dir, "package.json")))).toBe(FALLBACK_VERSION)
    expect(readManifestVersion(pathToFileURL(join(dir, "missing.json")))).toBe(FALLBACK_VERSION)
  })
})

describe("MCP: tools", () => {
  it("lists the nine tools with their schemas", async () => {
    const response = (await handleRpc(rpc("tools/list"), call)) as {
      result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> }
    }
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      "docx_fill",
      "docx_from_text",
      "xlsx_write",
      "pdf_from_markdown",
      "read_document",
      "documents_fill",
      "documents_convert",
      "archive_list",
      "archive_extract",
    ])
    expect(TOOLS).toHaveLength(9)
    expect(response.result.tools[0]?.inputSchema.required).toEqual(["title"])
    expect(response.result.tools[1]?.inputSchema.required).toEqual(["chatPath"])
    expect(response.result.tools[4]?.inputSchema.required).toEqual(["sourceArtifactID"])
    for (const tool of TOOLS) expect(tool.description).toContain("retry at most twice")
  })

  it("passes the tool name and arguments through", async () => {
    const seen: Array<{ name: string; args: unknown }> = []
    const response = await handleRpc(
      rpc("tools/call", 7, { name: "xlsx_write", arguments: { title: "t" } }),
      async (name, args) => {
        seen.push({ name, args })
        return { text: "wrote it", isError: false }
      },
    )
    expect(seen).toEqual([{ name: "xlsx_write", args: { title: "t" } }])
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "wrote it" }] },
    })
  })

  it("marks a tool error as isError and rejects unknown tools", async () => {
    const response = await handleRpc(
      rpc("tools/call", 3, { name: "docx_fill", arguments: {} }),
      async () => ({ text: "bad", isError: true }),
    )
    expect(response).toMatchObject({ result: { isError: true } })

    expect(await handleRpc(rpc("tools/call", 4, { name: "run_shell" }), call)).toMatchObject({
      error: { code: -32602 },
    })
  })

  it("survives a throwing handler", async () => {
    const response = await handleRpc(rpc("tools/call", 3, { name: "docx_fill" }), async () => {
      throw new Error("boom")
    })
    expect(response).toMatchObject({ result: { isError: true } })
  })
})

describe("MCP: protocol edges", () => {
  it("answers a notification with nothing and rejects an unknown method", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, call)).toBeNull()
    expect(await handleRpc(rpc("resources/list"), call)).toMatchObject({
      error: { code: -32601, message: "Method not found" },
    })
  })

  it("answers a non-object message with a parse error", async () => {
    expect(await handleRpc("hello", call)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
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
