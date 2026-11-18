import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { runPython } from "../src/runner"

/**
 * Opt-in integration test: it runs the real Python scripts and skips on any
 * machine without Python >= 3.12 and the pinned imports, so it never fails a
 * checkout that has no venv (`pnpm run setup:python` creates one). It never
 * touches the network.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")

function probe(command: string): string | null {
  const version = spawnSync(command, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
    encoding: "utf8",
  })
  if (version.status !== 0) return null
  const [major, minor] = version.stdout.trim().split(".").map(Number)
  if (major === undefined || minor === undefined) return null
  if (major < 3 || (major === 3 && minor < 12)) return null
  const imports = spawnSync(command, ["-c", "import docx, openpyxl, pypdf, reportlab, PIL"])
  return imports.status === 0 ? command : null
}

function findPython(): string | null {
  const explicit = process.env.OPENCHAT_PYTHON?.trim()
  const candidates = [
    explicit ? resolve(ROOT, explicit) : null,
    join(ROOT, ".venv", "bin", "python"),
    "python3",
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const found = probe(candidate)
    if (found) return found
  }
  return null
}

const python = findPython()
const created: string[] = []

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(python === null)("python document tools", () => {
  it(
    "round-trips DOCX, XLSX and PDF through the real scripts",
    async () => {
      if (!python) throw new Error("guarded by describe.skipIf")
      const tempRoot = mkdtempSync(join(tmpdir(), "python-tool-integration-"))
      created.push(tempRoot)
      const deps = { python, tempRoot, timeoutMs: 60_000 }

      const docx = await runPython(
        {
          script: "docx_fill",
          payload: { title: "Report", paragraphs: ["Hello round trip"], values: {} },
        },
        deps,
      )
      expect(docx.ok, docx.ok ? "" : docx.message).toBe(true)
      if (!docx.ok || !docx.value.file) throw new Error("no DOCX produced")
      expect(Array.from(docx.value.file.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])

      const docxText = await runPython(
        {
          script: "read_document",
          payload: { name: "report.docx", kind: "docx" },
          files: { "input.docx": docx.value.file.bytes },
        },
        deps,
      )
      expect(docxText.ok).toBe(true)
      if (docxText.ok) expect(docxText.value.text).toContain("Hello round trip")

      const xlsx = await runPython(
        {
          script: "xlsx_write",
          payload: {
            title: "Sheet",
            sheets: [{ name: "Data", rows: [["name", "age"], ["Ada", 36]] }],
          },
        },
        deps,
      )
      expect(xlsx.ok).toBe(true)
      if (!xlsx.ok || !xlsx.value.file) throw new Error("no XLSX produced")

      const xlsxText = await runPython(
        {
          script: "read_document",
          payload: { name: "sheet.xlsx", kind: "xlsx" },
          files: { "input.xlsx": xlsx.value.file.bytes },
        },
        deps,
      )
      expect(xlsxText.ok).toBe(true)
      if (xlsxText.ok) {
        expect(xlsxText.value.text).toContain("Ada")
        expect(xlsxText.value.text).toContain("36")
      }

      const pdf = await runPython(
        {
          script: "pdf_from_markdown",
          payload: { title: "PDF", markdown: "# Heading\n\nHello PDF with **bold** text." },
        },
        deps,
      )
      expect(pdf.ok).toBe(true)
      if (!pdf.ok || !pdf.value.file) throw new Error("no PDF produced")
      expect(Buffer.from(pdf.value.file.bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-")

      const pdfText = await runPython(
        {
          script: "read_document",
          payload: { name: "doc.pdf", kind: "pdf" },
          files: { "input.pdf": pdf.value.file.bytes },
        },
        deps,
      )
      expect(pdfText.ok).toBe(true)
      if (pdfText.ok) expect(pdfText.value.text).toContain("Hello PDF")
    },
    120_000,
  )
})
