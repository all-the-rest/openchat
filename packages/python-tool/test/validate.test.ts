import { describe, expect, it } from "vitest"
import {
  MAX_DOCUMENT_BYTES,
  MAX_MARKDOWN_CHARS,
  decodeBase64,
  validateDocxFill,
  validatePdfFromMarkdown,
  validateReadDocument,
  validateXlsxWrite,
} from "../src/validate"

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]).toString("base64")
const PDF = Buffer.from("%PDF-1.7\n").toString("base64")

function error(result: { ok: boolean; error?: string }): string {
  if (result.ok) throw new Error("expected a failure")
  return result.error ?? ""
}

describe("docx_fill validation", () => {
  it("accepts paragraphs without a template", () => {
    const result = validateDocxFill({ title: "Report", paragraphs: ["a", "b"] })
    expect(result).toEqual({
      ok: true,
      value: { title: "Report", paragraphs: ["a", "b"], values: {} },
    })
  })

  it("accepts a template and trims the title", () => {
    const result = validateDocxFill({ title: "  Report  ", template: ZIP, values: { name: "Ada" } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.title).toBe("Report")
      expect(result.value.template?.byteLength).toBe(8)
      expect(result.value.values).toEqual({ name: "Ada" })
    }
  })

  it.each([
    [null, "input: expected an object"],
    [{ paragraphs: ["a"] }, "title: must be a string"],
    [{ title: "   ", paragraphs: ["a"] }, "title: must not be empty"],
    [{ title: "x".repeat(121), paragraphs: ["a"] }, "title: 121 characters > 120"],
    [{ title: "t" }, "input: pass paragraphs or a template"],
    [{ title: "t", paragraphs: "a" }, "paragraphs: must be an array of strings"],
    [{ title: "t", paragraphs: [1] }, "paragraphs[0]: must be a string"],
    [{ title: "t", paragraphs: ["a\u0001"] }, "paragraphs[0]: contains a control character"],
    [{ title: "t", paragraphs: ["a"], values: { "bad key": "x" } }, "values.bad key:"],
    [{ title: "t", paragraphs: ["a"], values: { name: 3 } }, "values.name: must be a string"],
    [{ title: "t", paragraphs: ["a"], values: { name: "x".repeat(2001) } }, "values.name: longer"],
    [{ title: "t", template: "not base64!" }, "template: must be valid base64"],
    [{ title: "t", template: Buffer.from("plain").toString("base64") }, "template: not a .docx package"],
  ])("rejects %j", (input, message) => {
    expect(error(validateDocxFill(input))).toContain(message)
  })

  it("caps the paragraph list and total size", () => {
    const tooMany = Array.from({ length: 201 }, () => "a")
    expect(error(validateDocxFill({ title: "t", paragraphs: tooMany }))).toBe(
      "paragraphs: 201 entries > 200",
    )
    const long = Array.from({ length: 12 }, () => "a".repeat(20_000))
    expect(error(validateDocxFill({ title: "t", paragraphs: long }))).toContain(
      "total text larger than",
    )
  })
})

describe("xlsx_write validation", () => {
  it("keeps cell types and a formula string", () => {
    const result = validateXlsxWrite({
      title: "Sheet",
      sheets: [{ name: "Data", rows: [["a", 1, true, null], ["=SUM(B2:B2)"]] }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.sheets[0]?.rows[1]?.[0]).toBe("=SUM(B2:B2)")
  })

  it.each([
    [{ title: "t" }, "sheets: must be a non-empty array"],
    [{ title: "t", sheets: [] }, "sheets: must be a non-empty array"],
    [{ title: "t", sheets: [{ name: "", rows: [[]] }] }, "name: must not be empty"],
    [{ title: "t", sheets: [{ name: "a/b", rows: [[]] }] }, "name: must not contain []:*?/\\"],
    [{ title: "t", sheets: [{ name: "x".repeat(32), rows: [[]] }] }, "longer than 31 characters"],
    [{ title: "t", sheets: [{ name: "a", rows: [] }] }, "rows: must be a non-empty array"],
    [{ title: "t", sheets: [{ name: "a", rows: [[]] }] }, "rows[0]: must be a non-empty array"],
    [{ title: "t", sheets: [{ name: "a", rows: [[undefined]] }] }, "must be a string, number, boolean or null"],
    [{ title: "t", sheets: [{ name: "a", rows: [[Number.POSITIVE_INFINITY]] }] }, "must be a finite number"],
    [{ title: "t", sheets: [{ name: "a", rows: [["x".repeat(5001)]] }] }, "longer than 5000 characters"],
    [{ title: "t", sheets: [{ name: "a", rows: [["x\u0002"]] }] }, "contains a control character"],
  ])("rejects %j", (input, message) => {
    expect(error(validateXlsxWrite(input))).toContain(message)
  })

  it("rejects duplicate names case-insensitively and too many sheets", () => {
    const duplicate = validateXlsxWrite({
      title: "t",
      sheets: [
        { name: "Data", rows: [["a"]] },
        { name: "data", rows: [["b"]] },
      ],
    })
    expect(error(duplicate)).toBe("sheets[1].name: duplicate sheet name")

    const many = Array.from({ length: 11 }, (_, index) => ({ name: `s${index}`, rows: [["x"]] }))
    expect(error(validateXlsxWrite({ title: "t", sheets: many }))).toBe("sheets: 11 > 10")
  })

  it("caps rows and cells", () => {
    const rows = Array.from({ length: 5_001 }, () => ["x"])
    expect(error(validateXlsxWrite({ title: "t", sheets: [{ name: "a", rows }] }))).toContain(
      "rows: 5001 > 5000",
    )
    const cells = Array.from({ length: 101 }, () => "x")
    expect(error(validateXlsxWrite({ title: "t", sheets: [{ name: "a", rows: [cells] }] }))).toContain(
      "101 cells > 100",
    )
  })
})

describe("pdf_from_markdown validation", () => {
  it("accepts Markdown", () => {
    expect(validatePdfFromMarkdown({ title: "Doc", markdown: "# Hi" })).toEqual({
      ok: true,
      value: { title: "Doc", markdown: "# Hi" },
    })
  })

  it.each([
    [{ title: "t", markdown: "" }, "markdown: must not be empty"],
    [{ title: "t", markdown: "   " }, "markdown: must not be empty"],
    [{ title: "t", markdown: 3 }, "markdown: must be a string"],
    [{ title: "t", markdown: "a\u0000b" }, "markdown: contains a control character"],
  ])("rejects %j", (input, message) => {
    expect(error(validatePdfFromMarkdown(input))).toContain(message)
  })

  it("caps the Markdown length", () => {
    const markdown = "a".repeat(MAX_MARKDOWN_CHARS + 1)
    expect(error(validatePdfFromMarkdown({ title: "t", markdown }))).toBe(
      `markdown: longer than ${MAX_MARKDOWN_CHARS} characters`,
    )
  })
})

describe("read_document validation", () => {
  it("accepts a DOCX package and reports its kind", () => {
    const result = validateReadDocument({ name: "report.docx", base64: ZIP })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.kind).toBe("docx")
      expect(result.value.bytes.byteLength).toBe(8)
    }
  })

  it("accepts a PDF", () => {
    expect(validateReadDocument({ name: "a.PDF", base64: PDF }).ok).toBe(true)
  })

  it.each([
    [{ name: "a.txt", base64: ZIP }, "name: .docx, .xlsx, .pdf only"],
    [{ name: "../a.docx", base64: ZIP }, "name: must be one file name, not a path"],
    [{ name: "/etc/passwd.docx", base64: ZIP }, "name: must be one file name, not a path"],
    [{ name: ".hidden.docx", base64: ZIP }, "name: must be one file name, not a path"],
    [{ name: "a.docx", base64: PDF }, "document: not a .docx package"],
    [{ name: "a.pdf", base64: ZIP }, "document: not a PDF"],
    [{ name: "a.docx", base64: "" }, "document: must not be empty"],
  ])("rejects %j", (input, message) => {
    expect(error(validateReadDocument(input))).toContain(message)
  })

  it("rejects a document above the byte cap before decoding", () => {
    const encoded = "A".repeat(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 8)
    expect(error(decodeBase64(encoded, "document", MAX_DOCUMENT_BYTES))).toBe(
      `document: larger than ${Math.ceil(MAX_DOCUMENT_BYTES / 1024)} KiB`,
    )
  })

  it("rejects padding and alphabet violations", () => {
    expect(error(decodeBase64("a===", "x", 10))).toBe("x: must be valid base64")
    expect(error(decodeBase64("ab-_", "x", 10))).toBe("x: must be valid base64")
    expect(error(decodeBase64(7, "x", 10))).toBe("x: must be a base64 string")
  })
})
