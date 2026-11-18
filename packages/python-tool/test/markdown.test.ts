import { describe, expect, it } from "vitest"
import { parseMarkdown } from "../src/markdown"

/**
 * The subset is a contract, not a best effort: every construct the renderer
 * supports has one test, and everything outside it stays literal text.
 */

describe("Markdown subset: blocks", () => {
  it("parses h1-h3 and leaves h4 to the paragraph rule", () => {
    expect(parseMarkdown("# One\n## Two\n### Three\n#### Four")).toEqual([
      { kind: "heading", level: 1, text: "One" },
      { kind: "heading", level: 2, text: "Two" },
      { kind: "heading", level: 3, text: "Three" },
      { kind: "paragraph", text: "#### Four" },
    ])
  })

  it("joins soft-wrapped lines and splits paragraphs on a blank line", () => {
    expect(parseMarkdown("First line\nsecond line\n\nSecond paragraph")).toEqual([
      { kind: "paragraph", text: "First line second line" },
      { kind: "paragraph", text: "Second paragraph" },
    ])
  })

  it("parses dash and star bullets, including three leading spaces", () => {
    expect(parseMarkdown("- one\n* two\n   - three")).toEqual([
      { kind: "bullet", text: "one" },
      { kind: "bullet", text: "two" },
      { kind: "bullet", text: "three" },
    ])
  })

  it("keeps a fenced block verbatim, with or without a language tag and without a closing fence", () => {
    expect(parseMarkdown("```ts\nconst a = 1\n  indented\n```")).toEqual([
      { kind: "code", text: "const a = 1\n  indented" },
    ])
    expect(parseMarkdown("```\nno closing fence")).toEqual([
      { kind: "code", text: "no closing fence" },
    ])
  })

  it("parses a pipe table with an alignment row and pads short rows", () => {
    expect(parseMarkdown("| Item | Amount |\n|:-----|-------:|\n| Coffee | 4.5 |\n| Tea |")).toEqual([
      {
        kind: "table",
        rows: [
          ["Item", "Amount"],
          ["Coffee", "4.5"],
          ["Tea", ""],
        ],
      },
    ])
  })

  it("accepts a table without outer pipes", () => {
    expect(parseMarkdown("a | b\n--- | ---\n1 | 2")).toEqual([
      {
        kind: "table",
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
      },
    ])
  })

  it("handles CRLF and ignores empty fences", () => {
    expect(parseMarkdown("```\r\n```\r\n# Title\r\n")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
    ])
  })
})

describe("Markdown subset: deliberate omissions", () => {
  it("keeps HTML and images as literal text", () => {
    expect(parseMarkdown("<b>bold</b>\n\n![alt](https://example.com/x.png)")).toEqual([
      { kind: "paragraph", text: "<b>bold</b>" },
      { kind: "paragraph", text: "![alt](https://example.com/x.png)" },
    ])
  })

  it("keeps ordered lists, quotes and emphasis literal", () => {
    expect(parseMarkdown("1. first\n> quote\n**bold**")).toEqual([
      { kind: "paragraph", text: "1. first > quote **bold**" },
    ])
  })

  it("returns nothing for whitespace only", () => {
    expect(parseMarkdown("")).toEqual([])
    expect(parseMarkdown(" \n\t\n ")).toEqual([])
  })
})
