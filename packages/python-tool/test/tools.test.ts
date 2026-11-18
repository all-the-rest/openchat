import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ArtifactInternalCreateRequest, ArtifactWriteReceipt } from "@openchat/contracts"
import { ARTIFACT_MAX_BYTES } from "@openchat/contracts"
import { buildFileCard, mimeForDocument } from "../src/card"
import type { ProcessInvocation, ProcessOutcome, ProcessRunner } from "../src/process"
import { DOCUMENT_TOOLS, callDocumentTool } from "../src/tools"
import type { DocumentToolDeps, FileSink } from "../src/tools"

const SCRIPTS = ["docx_fill", "xlsx_write", "pdf_from_markdown", "read_document"]
const RECEIPT: ArtifactWriteReceipt = { artifactID: "c".repeat(64), title: "Report", bytes: 40_000 }
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]).toString("base64")
const PDF = Buffer.from("%PDF-1.7\n").toString("base64")

const created: string[] = []
let scriptDir: URL

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "python-tool-tools-"))
  created.push(dir)
  for (const name of SCRIPTS) writeFileSync(join(dir, `${name}.py`), "# fixture\n")
  scriptDir = pathToFileURL(`${dir}/`)
})

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "python-tool-deps-"))
  created.push(dir)
  return dir
}

function outcome(overrides: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return {
    status: 0,
    stdout: '{"ok":true}\n',
    stderr: "",
    timedOut: false,
    spawnFailed: false,
    stdoutOverflow: false,
    ...overrides,
  }
}

interface Fake {
  runner: ProcessRunner
  calls: ProcessInvocation[]
}

function fake(
  respond: (invocation: ProcessInvocation) => Partial<ProcessOutcome> = () => ({}),
): Fake {
  const calls: ProcessInvocation[] = []
  const runner: ProcessRunner = async (invocation) => {
    calls.push(invocation)
    return outcome(respond(invocation))
  }
  return { runner, calls }
}

function fileRunner(): Fake {
  return fake((invocation) => {
    const payload = JSON.parse(invocation.input) as { output: string }
    writeFileSync(join(invocation.cwd, payload.output), Buffer.from("generated-bytes"))
    return { stdout: JSON.stringify({ ok: true, file: payload.output }) }
  })
}

interface SinkSpy {
  sink: FileSink
  documents: ArtifactInternalCreateRequest[]
}

function sinkSpy(
  result: { ok: true; receipt: ArtifactWriteReceipt } | { ok: false; error: string } = {
    ok: true,
    receipt: RECEIPT,
  },
): SinkSpy {
  const documents: ArtifactInternalCreateRequest[] = []
  return {
    sink: {
      store: async (document) => {
        documents.push(document)
        return result
      },
    },
    documents,
  }
}

function deps(runner: ProcessRunner, sink: FileSink): DocumentToolDeps {
  return { python: "python3", sink, runProcess: runner, scriptDir, tempRoot: tempRoot(), timeoutMs: 500 }
}

describe("tool registry", () => {
  it("exposes exactly the six document tools", () => {
    expect(DOCUMENT_TOOLS.map((tool) => tool.name)).toEqual([
      "docx_fill",
      "xlsx_write",
      "pdf_from_markdown",
      "read_document",
      "documents_fill",
      "document_extract",
    ])
    for (const tool of DOCUMENT_TOOLS) {
      expect(tool.description).toContain("retry at most twice")
    }
    for (const name of ["docx_fill", "xlsx_write", "pdf_from_markdown", "read_document", "document_extract"]) {
      expect(DOCUMENT_TOOLS.find((tool) => tool.name === name)?.description).toContain("Never pass a file path")
    }
  })

  it("refuses an unknown tool without running anything", async () => {
    const { runner, calls } = fake()
    const result = await callDocumentTool("shell_exec", {}, deps(runner, sinkSpy().sink))
    expect(result).toEqual({ ok: false, error: "internal: unknown tool" })
    expect(calls).toHaveLength(0)
  })
})

describe("docx_fill", () => {
  it("runs the fixed script, validates the payload and stores one artifact", async () => {
    const { runner, calls } = fake((invocation) => {
      const payload = JSON.parse(invocation.input) as { output: string }
      expect(existsSync(join(invocation.cwd, "template.docx"))).toBe(true)
      writeFileSync(join(invocation.cwd, payload.output), Buffer.from("docx-bytes"))
      return { stdout: JSON.stringify({ ok: true, file: payload.output }) }
    })
    const { sink, documents } = sinkSpy()
    const result = await callDocumentTool(
      "docx_fill",
      { title: "Report", template: ZIP, values: { name: "Ada" } },
      deps(runner, sink),
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain(RECEIPT.artifactID)
    expect(calls).toHaveLength(1)
    expect(documents).toHaveLength(1)
    const document = documents[0]
    expect(document?.title).toBe("Report")
    expect(document?.html.startsWith("<!doctype html")).toBe(true)
    expect(document?.html).toContain("data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,")
    expect(Buffer.from(document?.html ?? "", "utf8").byteLength).toBeLessThanOrEqual(ARTIFACT_MAX_BYTES)
  })

  it("stops at validation without a process or a write", async () => {
    const { runner, calls } = fake()
    const { sink, documents } = sinkSpy()
    const result = await callDocumentTool("docx_fill", { title: "t" }, deps(runner, sink))
    expect(result).toEqual({ ok: false, error: "input: pass paragraphs or a template" })
    expect(calls).toHaveLength(0)
    expect(documents).toHaveLength(0)
  })

  it("reports a macro document with the stable message", async () => {
    const { runner } = fake(() => ({ stdout: '{"ok":false,"code":"macro_document"}' }))
    const result = await callDocumentTool(
      "docx_fill",
      { title: "t", template: ZIP },
      deps(runner, sinkSpy().sink),
    )
    expect(result).toEqual({
      ok: false,
      error: "unsupported: macro-enabled documents (.docm/.xlsm) are rejected",
    })
  })
})

describe("xlsx_write", () => {
  it("passes typed cells and formulas to the script", async () => {
    const { runner, calls } = fileRunner()
    const { sink, documents } = sinkSpy()
    const result = await callDocumentTool(
      "xlsx_write",
      { title: "Sheet", sheets: [{ name: "Data", rows: [["name", "total"], ["a", "=SUM(B2:B2)"]] }] },
      deps(runner, sink),
    )
    expect(result.ok).toBe(true)
    const payload = JSON.parse(calls[0]?.input ?? "{}") as { sheets: unknown }
    expect(payload.sheets).toEqual([{ name: "Data", rows: [["name", "total"], ["a", "=SUM(B2:B2)"]] }])
    expect(documents[0]?.html).toContain("data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,")
  })

  it("rejects an invalid sheet before running", async () => {
    const { runner, calls } = fake()
    const result = await callDocumentTool(
      "xlsx_write",
      { title: "t", sheets: [{ name: "a/b", rows: [["x"]] }] },
      deps(runner, sinkSpy().sink),
    )
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe("pdf_from_markdown", () => {
  it("stores a PDF card", async () => {
    const { runner } = fileRunner()
    const { sink, documents } = sinkSpy()
    const result = await callDocumentTool(
      "pdf_from_markdown",
      { title: "Doc", markdown: "# Hi" },
      deps(runner, sink),
    )
    expect(result.ok).toBe(true)
    expect(documents[0]?.html).toContain("data:application/pdf;base64,")
  })

  it("maps a timeout without a traceback", async () => {
    const { runner } = fake(() => ({ timedOut: true, status: null }))
    const result = await callDocumentTool(
      "pdf_from_markdown",
      { title: "Doc", markdown: "# Hi" },
      deps(runner, sinkSpy().sink),
    )
    expect(result).toEqual({
      ok: false,
      error: "timeout: the document tool ran longer than its limit and was stopped",
    })
    expect(JSON.stringify(result)).not.toContain("Traceback")
  })
})

describe("read_document", () => {
  it("returns the extracted text and writes no artifact", async () => {
    const { runner } = fake(() => ({ stdout: '{"ok":true,"text":"# Title\\n\\nbody"}' }))
    const { sink, documents } = sinkSpy()
    const result = await callDocumentTool(
      "read_document",
      { name: "report.docx", base64: ZIP },
      deps(runner, sink),
    )
    expect(result).toEqual({ ok: true, text: "# Title\n\nbody" })
    expect(documents).toHaveLength(0)
  })

  it("refuses a PDF that is not one before running", async () => {
    const { runner, calls } = fake()
    const result = await callDocumentTool(
      "read_document",
      { name: "report.pdf", base64: ZIP },
      deps(runner, sinkSpy().sink),
    )
    expect(result).toEqual({ ok: false, error: "document: not a PDF (%PDF- magic missing)" })
    expect(calls).toHaveLength(0)
  })

  it("reports an empty document", async () => {
    const { runner } = fake(() => ({ stdout: '{"ok":true,"text":"   "}' }))
    const result = await callDocumentTool(
      "read_document",
      { name: "report.pdf", base64: PDF },
      deps(runner, sinkSpy().sink),
    )
    expect(result).toEqual({
      ok: false,
      error: "unsupported: the document contains no extractable text",
    })
  })
})

describe("artifact sink", () => {
  it("returns the BFF error unchanged and stores nothing else", async () => {
    const { runner } = fileRunner()
    const result = await callDocumentTool(
      "pdf_from_markdown",
      { title: "Doc", markdown: "# Hi" },
      deps(runner, sinkSpy({ ok: false, error: "unavailable: the BFF has no artifact storage configured" }).sink),
    )
    expect(result).toEqual({
      ok: false,
      error: "unavailable: the BFF has no artifact storage configured",
    })
  })
})

describe("file card", () => {
  it("maps the three extensions to their media types", () => {
    expect(mimeForDocument("a.docx")).toContain("wordprocessingml")
    expect(mimeForDocument("a.xlsx")).toContain("spreadsheetml")
    expect(mimeForDocument("a.pdf")).toBe("application/pdf")
    expect(mimeForDocument("a.bin")).toBe("application/octet-stream")
  })

  it("refuses a file that would exceed one artifact", () => {
    const card = buildFileCard({ title: "big", fileName: "big.pdf", bytes: new Uint8Array(900_000) })
    expect(card).toEqual({ ok: false, error: "size: the generated file is too large for one artifact" })
  })

  it("stays below the artifact cap at the largest allowed file", () => {
    const card = buildFileCard({
      title: "max",
      fileName: "max.docx",
      bytes: new Uint8Array(700_000),
    })
    expect(card.ok).toBe(true)
    if (card.ok) expect(Buffer.byteLength(card.html, "utf8")).toBeLessThanOrEqual(ARTIFACT_MAX_BYTES)
  })

  it("escapes the file name in the card", () => {
    const card = buildFileCard({ title: "x", fileName: "a<b>.pdf", bytes: new Uint8Array([1]) })
    expect(card.ok).toBe(true)
    if (card.ok) {
      expect(card.html).toContain("a&lt;b&gt;.pdf")
      expect(card.html).not.toContain("<b>.pdf</h1>")
    }
  })
})
