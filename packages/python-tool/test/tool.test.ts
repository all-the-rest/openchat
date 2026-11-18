import type { FetchLike } from "@openchat/artifact-tool/bff"
import { describe, expect, it } from "vitest"
import type { PythonFile, PythonRunner } from "../src/runner"
import { buildFileArtifact, parseFileArtifact } from "../src/render"
import { runDocumentTool } from "../src/tool"

const BFF = "http://bff.example:8787"
const TOKEN = "test-internal-token-0123456789abcdef"
const RECEIPT = { artifactID: "b".repeat(64), title: "Letter", bytes: 1_200 }
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

interface Call {
  url: string
  init: RequestInit
}

function runnerOf(file: PythonFile = { filename: "letter.docx", mediaType: DOCX, data: Buffer.from("docx") }): {
  runner: PythonRunner
  calls: Array<{ tool: string; input: Record<string, unknown> }>
} {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
  const runner: PythonRunner = async (tool, input) => {
    calls.push({ tool, input })
    return { ok: true, value: file }
  }
  return { runner, calls }
}

function fetcher(options: {
  html?: string
  getStatus?: number
  postStatus?: number
} = {}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    if (init.method === "GET") {
      return new Response(options.html ?? "", {
        status: options.getStatus ?? 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    return new Response(JSON.stringify(RECEIPT), {
      status: options.postStatus ?? 201,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetch: fetchImpl, calls }
}

function deps(fetchImpl: FetchLike, runner: PythonRunner) {
  return { bffUrl: BFF, token: TOKEN, fetch: fetchImpl, runner }
}

describe("docx_fill tool", () => {
  it("runs the script, wraps the file and stores one artifact", async () => {
    const { runner, calls: runs } = runnerOf()
    const { fetch, calls } = fetcher()
    const result = await runDocumentTool(
      "docx_fill",
      { title: "Letter", paragraphs: ["Dear {{name}}"], values: { name: "Ada" } },
      deps(fetch, runner),
    )

    expect(result).toMatchObject({
      ok: true,
      value: { artifactID: RECEIPT.artifactID, filename: "letter.docx", fileBytes: 4 },
    })
    expect(runs).toEqual([
      {
        tool: "docx_fill",
        input: {
          filename: "Letter.docx",
          paragraphs: ["Dear {{name}}"],
          values: { name: "Ada" },
        },
      },
    ])
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]?.init.body)) as { title: string; html: string }
    expect(body.title).toBe("Letter")
    expect(body.html.startsWith("<!doctype html")).toBe(true)
    expect(parseFileArtifact(body.html)?.data.toString()).toBe("docx")
  })

  it("stops before the runner and the network on a validation error", async () => {
    const { runner, calls: runs } = runnerOf()
    const { fetch, calls } = fetcher()
    const result = await runDocumentTool("docx_fill", { title: "x" }, deps(fetch, runner))
    expect(result).toEqual({
      ok: false,
      error: "input: pass exactly one of paragraphs or templateArtifactID",
    })
    expect(runs).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it("reads a template artifact by id, never a path", async () => {
    const template = buildFileArtifact({
      title: "Template",
      filename: "template.docx",
      mediaType: DOCX,
      data: Buffer.from("template-bytes"),
    })
    const { runner, calls: runs } = runnerOf()
    const { fetch, calls } = fetcher({ html: template })
    const result = await runDocumentTool(
      "docx_fill",
      {
        title: "Filled",
        templateArtifactID: "a".repeat(64),
        values: { name: "Ada" },
      },
      deps(fetch, runner),
    )

    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe(`${BFF}/internal/artifacts/${"a".repeat(64)}`)
    expect(runs[0]?.input.template).toBe(Buffer.from("template-bytes").toString("base64"))
  })

  it("refuses a source artifact without an embedded file", async () => {
    const { runner } = runnerOf()
    const { fetch } = fetcher({ html: "<!doctype html><html><body>app</body></html>" })
    const result = await runDocumentTool(
      "docx_fill",
      { title: "Filled", templateArtifactID: "a".repeat(64), values: {} },
      deps(fetch, runner),
    )
    expect(result).toEqual({
      ok: false,
      error: "unsupported: the source artifact does not carry a document file",
    })
  })
})

describe("xlsx_write and pdf_from_markdown tools", () => {
  it("passes typed rows and formulas through", async () => {
    const { runner, calls: runs } = runnerOf({
      filename: "report.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: Buffer.from("xlsx"),
    })
    const { fetch } = fetcher()
    const result = await runDocumentTool(
      "xlsx_write",
      {
        title: "Report",
        sheet: "Q4",
        headers: ["Item", "Amount"],
        rows: [["Coffee", 4.5]],
        formulas: { B2: "1+1" },
      },
      deps(fetch, runner),
    )
    expect(result.ok).toBe(true)
    expect(runs[0]?.input).toMatchObject({ sheet: "Q4", rows: [["Coffee", 4.5]] })
  })

  it("stores a PDF and reports the BFF error verbatim from its fixed map", async () => {
    const { runner } = runnerOf({
      filename: "notes.pdf",
      mediaType: "application/pdf",
      data: Buffer.from("%PDF-1.7"),
    })
    const { fetch } = fetcher({ postStatus: 503 })
    const result = await runDocumentTool(
      "pdf_from_markdown",
      { title: "Notes", markdown: "# Hi" },
      deps(fetch, runner),
    )
    expect(result).toEqual({
      ok: false,
      error: "unavailable: the BFF has no artifact storage configured",
    })
  })
})

describe("read_document tool", () => {
  it("extracts a stored file and stores Markdown with a preview", async () => {
    const source = buildFileArtifact({
      title: "Letter",
      filename: "letter.docx",
      mediaType: DOCX,
      data: Buffer.from("docx-bytes"),
    })
    const { runner, calls: runs } = runnerOf({
      filename: "letter.md",
      mediaType: "text/markdown",
      data: Buffer.from("# Letter\n\nHello"),
    })
    const { fetch, calls } = fetcher({ html: source })
    const result = await runDocumentTool(
      "read_document",
      { sourceArtifactID: "a".repeat(64) },
      deps(fetch, runner),
    )

    expect(result).toMatchObject({
      ok: true,
      value: { filename: "letter.md", preview: "# Letter\n\nHello" },
    })
    expect(runs[0]?.input).toMatchObject({
      filename: "letter.docx",
      mediaType: DOCX,
      data: Buffer.from("docx-bytes").toString("base64"),
    })
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1)
  })

  it("maps a missing artifact without calling the runner", async () => {
    const { runner, calls: runs } = runnerOf()
    const { fetch } = fetcher({ getStatus: 404 })
    const result = await runDocumentTool(
      "read_document",
      { sourceArtifactID: "a".repeat(64) },
      deps(fetch, runner),
    )
    expect(result).toEqual({ ok: false, error: "not_found: the artifact does not exist" })
    expect(runs).toHaveLength(0)
  })
})
