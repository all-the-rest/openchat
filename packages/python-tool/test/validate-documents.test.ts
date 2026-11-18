import { describe, expect, it } from "vitest"
import { validateDocumentExtract, validateDocumentsFill } from "../src/validate"

const DOC = Buffer.from("PK\x03\x04template").toString("base64")

describe("documents_fill validation", () => {
  it("accepts a chat-relative template path and structured values", () => {
    const result = validateDocumentsFill({
      templatePath: "session-1/files/invoice.dotx",
      values: {
        customer: "Ada",
        items: [{ name: "Engine", amount: 100 }],
        approved: true,
      },
      name: "invoice",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.templatePath).toBe("session-1/files/invoice.dotx")
      expect(result.value.values).toMatchObject({ customer: "Ada", approved: true })
      expect(result.value.name).toBe("invoice")
    }
  })

  it("rejects absolute paths, traversal and wrong shapes before any read", () => {
    for (const templatePath of [
      "/etc/passwd",
      "../outside/files/a.dotx",
      "session-1/files/../../a.dotx",
      "session-1/a.dotx",
      "session-1/files/a.docm",
      "session-1\\files\\a.dotx",
      "session-1/files/nested/a.dotx",
    ]) {
      expect(validateDocumentsFill({ templatePath, values: {} }).ok, templatePath).toBe(false)
    }
  })

  it("rejects bad values and bad output names", () => {
    expect(validateDocumentsFill({ templatePath: "s/files/a.docx", values: { "..bad": "x" } }).ok).toBe(false)
    expect(validateDocumentsFill({ templatePath: "s/files/a.docx", values: { a: { b: { c: { d: { e: [] } } } } } }).ok).toBe(false)
    expect(validateDocumentsFill({ templatePath: "s/files/a.docx", values: {}, name: "../escape" }).ok).toBe(false)
  })
})

describe("document_extract validation", () => {
  it("accepts the formats the service understands", () => {
    for (const name of ["slides.pptx", "page.html", "report.pdf", "data.xlsx", "notes.md"]) {
      expect(validateDocumentExtract({ name, base64: DOC }).ok, name).toBe(true)
    }
  })

  it("refuses a path, a dotfile and an unsupported extension", () => {
    for (const name of ["../a.pptx", "dir/a.pptx", "a\\b.pptx", ".hidden", "virus.exe"]) {
      expect(validateDocumentExtract({ name, base64: DOC }).ok, name).toBe(false)
    }
  })
})
