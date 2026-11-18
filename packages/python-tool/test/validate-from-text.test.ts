import { describe, expect, it } from "vitest"
import {
  MAX_BLOCKS,
  MAX_BLOCK_TEXT_CHARS,
  MAX_CELL_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_TITLE,
} from "../src/limits"
import { validateTool } from "../src/validate"

const PATH = "session-1/files/report.docx"

function errorOf(input: Record<string, unknown>): string {
  const result = validateTool("docx_from_text", input)
  if (result.ok) throw new Error("expected a rejection")
  return result.error
}

describe("docx_from_text validation: blocks", () => {
  it("accepts the five block kinds and keeps the title out of the document when absent", () => {
    const result = validateTool("docx_from_text", {
      chatPath: PATH,
      blocks: [
        { kind: "heading", level: 2, text: "Quarter" },
        { kind: "paragraph", text: "Hello" },
        { kind: "bullet", text: "Point" },
        { kind: "code", text: "a\nb" },
        { kind: "table", rows: [["A", "B"], ["1", "2"]] },
      ],
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        name: "docx_from_text",
        value: {
          title: "Quarter",
          chatPath: PATH,
          filename: "report.docx",
        },
      },
    })
    if (result.ok && result.value.name === "docx_from_text") {
      expect(result.value.value.documentTitle).toBeUndefined()
      expect(result.value.value.blocks).toHaveLength(5)
    }
  })

  it("passes an explicit title to the document and uses it as the artifact title", () => {
    const result = validateTool("docx_from_text", {
      title: " Quarterly report ",
      chatPath: PATH,
      blocks: [{ kind: "paragraph", text: "Body" }],
    })
    expect(result).toMatchObject({
      ok: true,
      value: { value: { title: "Quarterly report", documentTitle: "Quarterly report" } },
    })
  })

  it("requires exactly one of blocks and markdown", () => {
    expect(errorOf({ chatPath: PATH })).toBe("input: pass exactly one of blocks or markdown")
    expect(
      errorOf({ chatPath: PATH, blocks: [{ kind: "paragraph", text: "a" }], markdown: "a" }),
    ).toBe("input: pass exactly one of blocks or markdown")
  })

  it("rejects an empty, oversized or malformed block list", () => {
    expect(errorOf({ chatPath: PATH, blocks: [] })).toBe("blocks: at least 1 entry required")
    expect(errorOf({ chatPath: PATH, blocks: new Array(MAX_BLOCKS + 1).fill({ kind: "paragraph", text: "a" }) })).toBe(
      `blocks: ${MAX_BLOCKS + 1} entries > ${MAX_BLOCKS}`,
    )
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "image", text: "x" }] })).toBe(
      "blocks[0].kind: must be heading, paragraph, bullet, code or table",
    )
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "paragraph", text: "   " }] })).toBe(
      "blocks[0].text: must not be empty",
    )
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "paragraph", text: "a\u0000b" }] })).toBe(
      "blocks[0].text: contains a control character",
    )
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "paragraph", text: "a\nb" }] })).toBe(
      "blocks[0].text: must not contain a line break",
    )
  })

  it("rejects a heading without a 1-3 level and allows newlines only in code", () => {
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "heading", text: "a" }] })).toBe(
      "blocks[0].level: must be 1, 2 or 3",
    )
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "heading", level: 4, text: "a" }] })).toBe(
      "blocks[0].level: must be 1, 2 or 3",
    )
    expect(validateTool("docx_from_text", {
      chatPath: PATH,
      blocks: [{ kind: "code", text: "line\nline" }],
    }).ok).toBe(true)
  })

  it("rejects a table over 50 rows, 8 columns, ragged rows and a non-string cell", () => {
    const rows = new Array(MAX_TABLE_ROWS + 1).fill(["a"])
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "table", rows }] })).toBe(
      `blocks[0].rows: ${MAX_TABLE_ROWS + 1} rows > ${MAX_TABLE_ROWS}`,
    )
    const wide = [new Array(MAX_TABLE_COLUMNS + 1).fill("a")]
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "table", rows: wide }] })).toBe(
      `blocks[0].rows[0]: ${MAX_TABLE_COLUMNS + 1} cells > ${MAX_TABLE_COLUMNS}`,
    )
    expect(
      errorOf({ chatPath: PATH, blocks: [{ kind: "table", rows: [["a", "b"], ["c"]] }] }),
    ).toBe("blocks[0].rows[1]: expected 2 cells, got 1")
    expect(errorOf({ chatPath: PATH, blocks: [{ kind: "table", rows: [[1]] }] })).toBe(
      "blocks[0].rows[0][0]: must be a plain string",
    )
    expect(
      errorOf({ chatPath: PATH, blocks: [{ kind: "table", rows: [["a".repeat(MAX_CELL_CHARS + 1)]] }] }),
    ).toBe(`blocks[0].rows[0][0]: ${MAX_CELL_CHARS + 1} characters > ${MAX_CELL_CHARS}`)
  })

  it("caps the total character count, not just one block", () => {
    const half = "a".repeat(MAX_BLOCK_TEXT_CHARS / 2 + 1)
    expect(
      errorOf({
        chatPath: PATH,
        blocks: [
          { kind: "paragraph", text: half },
          { kind: "paragraph", text: half },
        ],
      }),
    ).toBe(`blocks: ${MAX_BLOCK_TEXT_CHARS + 2} characters > ${MAX_BLOCK_TEXT_CHARS}`)
  })
})

describe("docx_from_text validation: markdown", () => {
  it("converts the subset to blocks and derives the title from it", () => {
    const result = validateTool("docx_from_text", {
      chatPath: PATH,
      markdown: "# Report\n\nHello **world**\n\n- a\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        value: {
          title: "Report",
          blocks: [
            { kind: "heading", level: 1, text: "Report" },
            { kind: "paragraph", text: "Hello **world**" },
            { kind: "bullet", text: "a" },
            { kind: "table", rows: [["A", "B"], ["1", "2"]] },
          ],
        },
      },
    })
  })

  it("rejects empty, oversized and unsupported markdown", () => {
    expect(errorOf({ chatPath: PATH, markdown: "   " })).toBe("markdown: must not be empty")
    expect(errorOf({ chatPath: PATH, markdown: 42 })).toBe("markdown: must be a string")
    expect(errorOf({ chatPath: PATH, markdown: "```\n```" })).toBe("markdown: no supported content")
    expect(errorOf({ chatPath: PATH, markdown: "a".repeat(MAX_BLOCK_TEXT_CHARS + 1) })).toBe(
      `markdown: ${MAX_BLOCK_TEXT_CHARS + 1} characters > ${MAX_BLOCK_TEXT_CHARS}`,
    )
  })

  it("applies the block caps to the parsed result", () => {
    const table = ["| a |", "| --- |", ...Array.from({ length: MAX_TABLE_ROWS }, () => "| x |")]
    expect(errorOf({ chatPath: PATH, markdown: table.join("\n") })).toBe(
      `blocks[0].rows: ${MAX_TABLE_ROWS + 1} rows > ${MAX_TABLE_ROWS}`,
    )
    expect(errorOf({ chatPath: PATH, markdown: Array.from({ length: MAX_BLOCKS + 1 }, () => "- x").join("\n") })).toBe(
      `blocks: ${MAX_BLOCKS + 1} entries > ${MAX_BLOCKS}`,
    )
  })
})

describe("docx_from_text validation: title and chatPath", () => {
  it("rejects an over-long or control-character title", () => {
    expect(
      errorOf({ chatPath: PATH, title: "🎉".repeat(MAX_TITLE + 1), blocks: [{ kind: "paragraph", text: "a" }] }),
    ).toBe(`title: ${MAX_TITLE + 1} characters > ${MAX_TITLE}`)
    expect(
      errorOf({ chatPath: PATH, title: "a\u0000b", blocks: [{ kind: "paragraph", text: "a" }] }),
    ).toBe("title: contains a control character")
  })

  it("accepts only <session>/files/<name>.docx", () => {
    const block = [{ kind: "paragraph", text: "a" }]
    for (const chatPath of [
      "/tmp/report.docx",
      "session-1/report.docx",
      "session-1/files/report.pdf",
      "session-1/files/../report.docx",
      "session-1/files/nested/report.docx",
      "session-1/files/..docx",
    ]) {
      expect(errorOf({ chatPath, blocks: block }), chatPath).toBe(
        "chatPath: use <sessionID>/files/<name>.docx",
      )
    }
    expect(validateTool("docx_from_text", { chatPath: "session-1/files/A4 Report.docx", blocks: block }).ok).toBe(
      true,
    )
  })
})
