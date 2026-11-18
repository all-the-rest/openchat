import { describe, expect, it } from "vitest"
import { validateTool } from "../src/validate"

const FILL = { templatePath: "session-1/files/invoice.dotx", values: {} }

describe("documents_fill validation", () => {
  it("accepts a chat-relative template and structured values", () => {
    const result = validateTool("documents_fill", {
      ...FILL,
      values: {
        customer: "Ada",
        items: [{ name: "Engine", amount: 100 }],
        approved: true,
      },
      name: "invoice",
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.name === "documents_fill") {
      expect(result.value.value.templatePath).toBe("session-1/files/invoice.dotx")
      expect(result.value.value.values).toMatchObject({ customer: "Ada", approved: true })
      expect(result.value.value.name).toBe("invoice")
    }
  })

  it("rejects absolute paths, traversal and the wrong shape", () => {
    for (const templatePath of [
      "/etc/passwd",
      "../outside/files/a.dotx",
      "session-1/files/../../a.dotx",
      "session-1/a.dotx",
      "session-1/files/a.docm",
      "session-1\\files\\a.dotx",
      "session-1/files/nested/a.dotx",
    ]) {
      expect(validateTool("documents_fill", { ...FILL, templatePath }).ok, templatePath).toBe(false)
    }
  })

  it("rejects bad values, nested values and bad output names", () => {
    expect(validateTool("documents_fill", { ...FILL, values: { "..bad": "x" } }).ok).toBe(false)
    expect(validateTool("documents_fill", { ...FILL, values: { a: { b: { c: { d: { e: [] } } } } } }).ok).toBe(false)
    expect(validateTool("documents_fill", { ...FILL, name: "../escape" }).ok).toBe(false)
  })
})

describe("documents_convert validation", () => {
  it("accepts only a DOCX in a chat files folder", () => {
    expect(validateTool("documents_convert", { templatePath: "session-1/files/a.docx" }).ok).toBe(true)
    expect(validateTool("documents_convert", { templatePath: "session-1/files/a.dotx" }).ok).toBe(false)
    expect(validateTool("documents_convert", { templatePath: "/tmp/a.docx" }).ok).toBe(false)
  })
})
