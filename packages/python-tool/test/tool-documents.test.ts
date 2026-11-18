import type { FetchLike } from "@openchat/artifact-tool/bff"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { DocumentsClient, DocumentsResult } from "../src/documents-client"
import type { PythonRunner } from "../src/runner"
import type { ToolDeps } from "../src/tool"
import { isToolSuccess, runDocumentTool } from "../src/tool"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const RECEIPT = { artifactID: "d".repeat(64), title: "invoice", bytes: 1_200 }

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "python-tool-doc-"))
  created.push(root)
  const files = join(root, "chats", "session-1", "files")
  mkdirSync(files, { recursive: true, mode: 0o700 })
  writeFileSync(join(files, "invoice.dotx"), Buffer.from("PK\x03\x04fake"))
  writeFileSync(join(files, "source.docx"), Buffer.from("PK\x03\x04source"))
  return root
}

type FillValue = { docx: Uint8Array; pdf: Uint8Array; docxName: string; pdfName: string }
type ConvertValue = { pdf: Uint8Array; pdfName: string }

interface Spy {
  client: DocumentsClient
  calls: string[]
  posts: Array<{ title: string; html: string }>
}

function spy(overrides: Partial<DocumentsClient> = {}): Spy {
  const calls: string[] = []
  const posts: Array<{ title: string; html: string }> = []
  const client: DocumentsClient = {
    fill:
      overrides.fill ??
      (async (request) => {
        calls.push(`fill:${request.name}`)
        return {
          ok: true,
          value: {
            docx: new Uint8Array(Buffer.from("filled-docx")),
            pdf: new Uint8Array(Buffer.from("%PDF-1.7")),
            docxName: "invoice.docx",
            pdfName: "invoice.pdf",
          },
        }
      }),
    convert:
      overrides.convert ??
      (async () => {
        calls.push("convert")
        return { ok: true, value: { pdf: new Uint8Array(Buffer.from("%PDF-1.7")), pdfName: "source.pdf" } }
      }),
  }
  return { client, calls, posts }
}

function deps(root: string, s: Spy): ToolDeps {
  const fetchImpl: FetchLike = async (_url, init) => {
    if (init.method === "POST") {
      s.posts.push(JSON.parse(String(init.body)) as { title: string; html: string })
      return new Response(JSON.stringify(RECEIPT), { status: 201 })
    }
    return new Response("", { status: 404 })
  }
  const runner: PythonRunner = async () => {
    throw new Error("the documents tools must not start Python")
  }
  return {
    bffUrl: "http://bff:8787",
    token: "token",
    fetch: fetchImpl,
    runner,
    workspaceDir: root,
    documents: s.client,
  }
}

const FILL = { templatePath: "session-1/files/invoice.dotx", values: { customer: "Ada" }, name: "invoice" }

describe("documents_fill tool", () => {
  it("writes both files into the chat folder and stores both cards", async () => {
    const root = workspace()
    const s = spy()
    const result = await runDocumentTool("documents_fill", FILL, deps(root, s))
    expect(result.ok).toBe(true)
    if (result.ok && isToolSuccess(result.value)) {
      expect(result.value.files).toEqual(["invoice.docx", "invoice.pdf"])
      expect(result.value.filename).toBe("invoice.docx")
    }
    expect(s.calls).toEqual(["fill:invoice"])
    expect(s.posts).toHaveLength(2)
    expect(readFileSync(join(root, "chats", "session-1", "files", "invoice.pdf")).toString()).toBe("%PDF-1.7")
  })

  it("refuses a path outside chats before any service or filesystem call", async () => {
    const root = workspace()
    const s = spy()
    const result = await runDocumentTool("documents_fill", { ...FILL, templatePath: "/etc/passwd" }, deps(root, s))
    expect(result.ok).toBe(false)
    expect(s.calls).toEqual([])
    expect(s.posts).toEqual([])
  })

  it("maps a service error without a traceback", async () => {
    const root = workspace()
    const failure: DocumentsResult<FillValue> = {
      ok: false,
      error: "unsupported: macro-enabled documents are rejected",
    }
    const s = spy({ fill: async () => failure })
    expect(await runDocumentTool("documents_fill", FILL, deps(root, s))).toEqual(failure)
    expect(s.posts).toEqual([])
  })
})

describe("documents_convert tool", () => {
  it("exports a chat DOCX into a PDF beside it", async () => {
    const root = workspace()
    const s = spy()
    const result = await runDocumentTool(
      "documents_convert",
      { templatePath: "session-1/files/source.docx", name: "source" },
      deps(root, s),
    )
    expect(result.ok).toBe(true)
    if (result.ok && isToolSuccess(result.value)) expect(result.value.files).toEqual(["source.pdf"])
    expect(s.calls).toEqual(["convert"])
    expect(readFileSync(join(root, "chats", "session-1", "files", "source.pdf")).toString()).toBe("%PDF-1.7")
  })

  it("maps a convert failure to a stable sentence", async () => {
    const root = workspace()
    const failure: DocumentsResult<ConvertValue> = {
      ok: false,
      error: "convert: the document could not be exported as a PDF",
    }
    const s = spy({ convert: async () => failure })
    expect(await runDocumentTool(
      "documents_convert",
      { templatePath: "session-1/files/source.docx" },
      deps(root, s),
    )).toEqual(failure)
  })
})
