import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { TOOL_NAMES } from "./validate"

/**
 * The MCP surface: one stdio server exposing the four document tools, newline
 * delimited JSON-RPC. The protocol is intentionally the same small subset the
 * artifact tool uses (`initialize`, `ping`, `tools/list`, `tools/call`); a
 * tool error is a result, never a crash, and no argument is echoed back.
 */

export const SERVER_NAME = "openchat-python"
export const PACKAGE_MANIFEST = new URL("../package.json", import.meta.url)
export const FALLBACK_VERSION = "0.0.0-dev"
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

const RETRY = "If the tool rejects the input, fix exactly what the message names and retry at most twice."

export const DOCX_TOOL = {
  name: "docx_fill",
  title: "Create or fill a Word document",
  description: [
    "Create a DOCX from `paragraphs`, or fill an existing DOCX produced by this tool (`templateArtifactID`).",
    "`values` replaces `{{name}}` placeholders in paragraphs, tables, headers and footers.",
    "Pass exactly one of `paragraphs` and `templateArtifactID`. The result is stored as an artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title, at most 120 characters." },
      outputName: { type: "string", description: "Optional file name ending in .docx." },
      paragraphs: {
        type: "array",
        items: { type: "string" },
        description: "1–200 paragraphs; use {{key}} placeholders. Required without a template.",
      },
      templateArtifactID: {
        type: "string",
        description: "64-hex id of a .docx artifact produced by this tool. Required without paragraphs.",
      },
      values: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Placeholder values, at most 64 entries.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
} as const

export const XLSX_TOOL = {
  name: "xlsx_write",
  title: "Write a spreadsheet",
  description: [
    "Write one XLSX sheet with typed cells. `rows` hold strings, numbers, booleans or null;",
    "formulas are set explicitly with `formulas` ({ \"B2\": \"SUM(B1:B1)\" }).",
    "A data cell starting with = is rejected; use the formulas map. The result is stored as an artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title, at most 120 characters." },
      outputName: { type: "string", description: "Optional file name ending in .xlsx." },
      sheet: { type: "string", description: "Sheet name, at most 31 characters." },
      headers: { type: "array", items: { type: "string" }, description: "1–50 column headers." },
      rows: {
        type: "array",
        items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
        description: "At most 5000 rows; each row has exactly one cell per header.",
      },
      formulas: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Cell reference to formula, e.g. {\"D2\": \"B2*C2\"}.",
      },
    },
    required: ["title", "sheet", "headers", "rows"],
    additionalProperties: false,
  },
} as const

export const PDF_TOOL = {
  name: "pdf_from_markdown",
  title: "Create a PDF from Markdown",
  description: [
    "Render Markdown (headings, lists, paragraphs, fenced code) to a PDF with selectable text.",
    "No fonts or resources are fetched; the result is stored as an artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title, at most 120 characters." },
      outputName: { type: "string", description: "Optional file name ending in .pdf." },
      markdown: { type: "string", description: "Markdown source, at most 200 KiB." },
    },
    required: ["title", "markdown"],
    additionalProperties: false,
  },
} as const

export const READ_TOOL = {
  name: "read_document",
  title: "Read a document as Markdown",
  description: [
    "Extract Markdown from a DOCX, XLSX, PPTX, PDF or text artifact produced by this tool set.",
    "Conversion uses the bundled markitdown converter; no model or font is downloaded.",
    "The preview is returned in the result and the full text is stored as a .md artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional title for the extracted Markdown artifact." },
      sourceArtifactID: {
        type: "string",
        description: "64-hex id of a document artifact produced by this tool set.",
      },
    },
    required: ["sourceArtifactID"],
    additionalProperties: false,
  },
} as const

export const TOOLS = [DOCX_TOOL, XLSX_TOOL, PDF_TOOL, READ_TOOL] as const

export interface ToolCallResult {
  text: string
  isError: boolean
}

export type ToolHandler = (name: string, args: unknown) => Promise<ToolCallResult>

export type JsonRpcId = string | number | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readManifestVersion(manifest: URL = PACKAGE_MANIFEST): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"))
    if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // Fall through to the placeholder.
  }
  return FALLBACK_VERSION
}

export const SERVER_VERSION = readManifestVersion()

function failure(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } }
}

function negotiateProtocol(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested
  }
  return DEFAULT_PROTOCOL_VERSION
}

function toolContent(result: ToolCallResult): unknown {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  }
}

function isKnownTool(name: unknown): name is (typeof TOOL_NAMES)[number] {
  return typeof name === "string" && (TOOL_NAMES as readonly string[]).includes(name)
}

export async function handleRpc(message: unknown, call: ToolHandler): Promise<unknown> {
  if (!isRecord(message)) return failure(null, -32700, "Parse error")

  const rawId = message.id
  const id: JsonRpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null
  const method = typeof message.method === "string" ? message.method : undefined
  if (!method) return failure(id, -32600, "Invalid Request")
  if (rawId === undefined) return null

  const params = isRecord(message.params) ? message.params : {}

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocol(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [...TOOLS] } }
    case "tools/call": {
      if (!isKnownTool(params.name)) return failure(id, -32602, "Unknown tool")
      try {
        const result = await call(params.name, isRecord(params.arguments) ? params.arguments : {})
        return { jsonrpc: "2.0", id, result: toolContent(result) }
      } catch {
        return {
          jsonrpc: "2.0",
          id,
          result: toolContent({ text: "internal: the tool failed", isError: true }),
        }
      }
    }
    default:
      return failure(id, -32601, "Method not found")
  }
}

export async function serveStdio(options: {
  input: Readable
  output: Writable
  call: ToolHandler
}): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      options.output.write(`${JSON.stringify(failure(null, -32700, "Parse error"))}\n`)
      continue
    }

    const response = await handleRpc(parsed, options.call)
    if (response !== null) options.output.write(`${JSON.stringify(response)}\n`)
  }
}
