import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ArtifactInternalCreateRequest, ArtifactWriteReceipt } from "@openchat/contracts"
import type { DocumentsClient, DocumentsResult } from "../src/documents-client"
import type { DocumentToolDeps, FileSink, ToolResult } from "../src/tools"
import { callDocumentTool } from "../src/tools"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const RECEIPT: ArtifactWriteReceipt = { artifactID: "d".repeat(64), title: "Invoice", bytes: 20_000 }

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "python-tool-documents-"))
  created.push(root)
  const files = join(root, "chats", "session-1", "files")
  mkdirSync(files, { recursive: true, mode: 0o700 })
  writeFileSync(join(files, "invoice.dotx"), Buffer.from("PK\x03\x04fake"))
  return root
}

interface Spy {
  client: DocumentsClient
  calls: string[]
  sink: FileSink
  stored: ArtifactInternalCreateRequest[]
}

function spy(overrides: Partial<DocumentsClient> = {}): Spy {
  const calls: string[] = []
  const stored: ArtifactInternalCreateRequest[] = []
  const client: DocumentsClient = {
    fill:
      overrides.fill ??
      (async (request) => {
        calls.push(`fill:${request.name}`)
        return {
          ok: true,
          value: {
            docx: new Uint8Array(Buffer.from("filled-docx")),
            pdf: new Uint8Array(Buffer.from("%PDF-1.7\n")),
            docxName: "invoice.docx",
            pdfName: "invoice.pdf",
          },
        }
      }),
    extract:
      overrides.extract ??
      (async () => {
        calls.push("extract")
        return { ok: true, value: { markdown: "# Slides\nHello" } }
      }),
  }
  return {
    client,
    calls,
    stored,
    sink: {
      store: async (document) => {
        stored.push(document)
        return { ok: true, receipt: RECEIPT }
      },
    },
  }
}

function deps(root: string, s: Spy): DocumentToolDeps {
  return {
    python: "python3",
    sink: s.sink,
    workspaceDir: root,
    documents: s.client,
    runProcess: async () => {
      throw new Error("documents_fill must not start Python")
    },
  }
}

const FILL = {
  templatePath: "session-1/files/invoice.dotx",
  values: { customer: "Ada" },
  name: "invoice",
}

describe("documents_fill tool", () => {
  it("reads the template, stores both outputs and returns both file names", async () => {
    const root = workspace()
    const s = spy()
    const result: ToolResult = await callDocumentTool("documents_fill", FILL, deps(root, s))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toContain("invoice.docx")
      expect(result.text).toContain("invoice.pdf")
    }
    expect(s.calls).toEqual(["fill:invoice"])
    expect(s.stored).toHaveLength(2)
    expect(s.stored[0]?.title).toBe("invoice")
  })

  it("refuses a path outside the chats directory before calling the service", async () => {
    const root = workspace()
    const s = spy()
    const result = await callDocumentTool(
      "documents_fill",
      { ...FILL, templatePath: "/etc/passwd" },
      deps(root, s),
    )
    expect(result.ok).toBe(false)
    expect(s.calls).toEqual([])
    expect(s.stored).toEqual([])
  })

  it("maps service errors to fixed text without a traceback", async () => {
    const root = workspace()
    const failing: DocumentsResult<{ docx: Uint8Array; pdf: Uint8Array; docxName: string; pdfName: string }> = {
      ok: false,
      error: "unsupported: macro-enabled documents (.docm/.xlsm) are rejected",
    }
    const s = spy({ fill: async () => failing })
    const result = await callDocumentTool("documents_fill", FILL, deps(root, s))
    expect(result).toEqual(failing)
    expect(s.stored).toEqual([])
  })

  it("requires the service and a workspace root", async () => {
    const root = workspace()
    const s = spy()
    const result = await callDocumentTool(
      "documents_fill",
      FILL,
      { ...deps(root, s), documents: undefined },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("documents service is unreachable")
  })
})

describe("document_extract tool", () => {
  const INPUT = { name: "slides.pptx", base64: Buffer.from("PK\x03\x04pptx").toString("base64") }

  it("returns markdown from the service", async () => {
    const s = spy()
    const result = await callDocumentTool("document_extract", INPUT, deps(workspace(), s))
    expect(result).toEqual({ ok: true, text: "# Slides\nHello" })
    expect(s.calls).toEqual(["extract"])
  })

  it("rejects empty text and maps service errors", async () => {
    const empty = spy({
      extract: async () => ({ ok: true, value: { markdown: "   \n" } }),
    })
    const result = await callDocumentTool("document_extract", INPUT, deps(workspace(), empty))
    expect(result.ok).toBe(false)

    const failed = spy({
      extract: async () => ({ ok: false, error: "service: the documents service rejected the request" }),
    })
    const second = await callDocumentTool("document_extract", INPUT, deps(workspace(), failed))
    expect(second).toEqual({
      ok: false,
      error: "service: the documents service rejected the request",
    })
  })
})
