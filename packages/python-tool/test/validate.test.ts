import { describe, expect, it } from "vitest"
import { MAX_MARKDOWN_BYTES, MAX_VALUE_CHARS } from "../src/limits"
import { validateTool } from "../src/validate"

const ID = "a".repeat(64)

function errorOf(name: string, input: unknown): string {
  const result = validateTool(name, input)
  if (result.ok) throw new Error("expected a rejection")
  return result.error
}

describe("docx_fill validation", () => {
  it("accepts paragraphs and values", () => {
    const result = validateTool("docx_fill", {
      title: "  Letter  ",
      paragraphs: ["Dear {{name}}", "{{body}}"],
      values: { name: "Ada", body: "Hello" },
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        name: "docx_fill",
        value: {
          title: "Letter",
          outputName: "Letter.docx",
          paragraphs: ["Dear {{name}}", "{{body}}"],
          values: { name: "Ada", body: "Hello" },
        },
      },
    })
  })

  it("accepts a template id and an explicit output name", () => {
    const result = validateTool("docx_fill", {
      title: "Letter",
      templateArtifactID: ID,
      outputName: "letter-final.docx",
      values: {},
    })
    expect(result).toMatchObject({
      ok: true,
      value: { value: { templateArtifactID: ID, outputName: "letter-final.docx" } },
    })
  })

  it("rejects both or neither input shape", () => {
    expect(errorOf("docx_fill", { title: "x", templateArtifactID: ID, paragraphs: ["a"] })).toBe(
      "input: pass exactly one of paragraphs or templateArtifactID",
    )
    expect(errorOf("docx_fill", { title: "x" })).toBe(
      "input: pass exactly one of paragraphs or templateArtifactID",
    )
  })

  it("rejects a bad template id and a wrong extension", () => {
    expect(
      errorOf("docx_fill", { title: "x", templateArtifactID: "ABC", values: {} }),
    ).toBe("templateArtifactID: expected 64 lowercase hex characters")
    expect(
      errorOf("docx_fill", { title: "x", paragraphs: ["a"], outputName: "x.pdf" }),
    ).toBe("outputName: must end with .docx")
  })

  it("rejects a bad placeholder key and an oversized value", () => {
    expect(errorOf("docx_fill", { title: "x", paragraphs: ["a"], values: { "1bad": "v" } })).toBe(
      "values.1bad: use letters, digits, underscore, dot or dash",
    )
    expect(
      errorOf("docx_fill", {
        title: "x",
        paragraphs: ["a"],
        values: { name: "v".repeat(MAX_VALUE_CHARS + 1) },
      }),
    ).toBe(`values.name: ${MAX_VALUE_CHARS + 1} characters > ${MAX_VALUE_CHARS}`)
  })
})

describe("xlsx_write validation", () => {
  it("accepts a typed sheet and formulas", () => {
    const result = validateTool("xlsx_write", {
      title: "Report",
      sheet: "Q4",
      headers: ["Item", "Amount"],
      rows: [
        ["Coffee", 4.5],
        ["Tea", null],
      ],
      formulas: { B3: "SUM(B2:B2)" },
    })
    expect(result).toMatchObject({
      ok: true,
      value: { name: "xlsx_write", value: { sheet: "Q4", formulas: { B3: "SUM(B2:B2)" } } },
    })
  })

  it("rejects a row with the wrong width", () => {
    expect(
      errorOf("xlsx_write", {
        title: "x",
        sheet: "S",
        headers: ["A", "B"],
        rows: [["one"]],
      }),
    ).toBe("rows[0]: expected 2 cells, got 1")
  })

  it("rejects a data cell that starts with =", () => {
    expect(
      errorOf("xlsx_write", {
        title: "x",
        sheet: "S",
        headers: ["A"],
        rows: [["=1+1"]],
      }),
    ).toBe("rows[0][0]: start = only through the formulas map")
  })

  it("rejects an invalid sheet name and formula reference", () => {
    expect(errorOf("xlsx_write", { title: "x", sheet: "a/b", headers: ["A"], rows: [] })).toBe(
      "sheet: must not contain \\ / ? * [ ] :",
    )
    expect(
      errorOf("xlsx_write", {
        title: "x",
        sheet: "S",
        headers: ["A"],
        rows: [],
        formulas: { "1A": "1+1" },
      }),
    ).toBe("formulas.1A: not a cell reference")
  })

  it("rejects a non-finite number", () => {
    expect(
      errorOf("xlsx_write", {
        title: "x",
        sheet: "S",
        headers: ["A"],
        rows: [[Number.POSITIVE_INFINITY]],
      }),
    ).toBe("rows[0][0]: must be a finite number")
  })
})

describe("pdf_from_markdown validation", () => {
  it("accepts Markdown", () => {
    expect(
      validateTool("pdf_from_markdown", { title: "Notes", markdown: "# Hi" }),
    ).toMatchObject({ ok: true, value: { value: { outputName: "Notes.pdf" } } })
  })

  it("rejects empty and oversized Markdown", () => {
    expect(errorOf("pdf_from_markdown", { title: "x", markdown: "  " })).toBe(
      "markdown: must not be empty",
    )
    const padding = "x".repeat(MAX_MARKDOWN_BYTES + 1)
    expect(errorOf("pdf_from_markdown", { title: "x", markdown: padding })).toBe(
      `markdown: ${Math.ceil((MAX_MARKDOWN_BYTES + 1) / 1024)} KiB > ${
        MAX_MARKDOWN_BYTES / 1024
      } KiB`,
    )
  })
})

describe("read_document validation", () => {
  it("accepts an artifact id with and without a title", () => {
    expect(validateTool("read_document", { sourceArtifactID: ID })).toMatchObject({
      ok: true,
      value: { name: "read_document", value: { sourceArtifactID: ID } },
    })
    expect(
      validateTool("read_document", { sourceArtifactID: ID, title: "Text" }),
    ).toMatchObject({ ok: true, value: { value: { title: "Text" } } })
  })

  it("rejects a path or a short id", () => {
    expect(errorOf("read_document", { sourceArtifactID: "/tmp/x.docx" })).toBe(
      "sourceArtifactID: expected 64 lowercase hex characters",
    )
  })
})

describe("shared validation", () => {
  it("rejects a non-object and an unknown tool", () => {
    expect(errorOf("docx_fill", null)).toBe("input: expected an object")
    expect(errorOf("run_shell", { title: "x" })).toBe("input: unknown tool")
  })

  it("counts title code points, not UTF-16 units", () => {
    expect(validateTool("pdf_from_markdown", { title: "🎉".repeat(120), markdown: "x" }).ok).toBe(
      true,
    )
    expect(
      errorOf("pdf_from_markdown", { title: "🎉".repeat(121), markdown: "x" }),
    ).toBe("title: 121 characters > 120")
  })

  it("rejects control characters in a title", () => {
    expect(
      errorOf("pdf_from_markdown", { title: "a\u0000b", markdown: "x" }),
    ).toBe("title: contains a control character")
  })
})
