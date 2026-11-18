import { describe, expect, it } from "vitest"
import { buildFileArtifact, parseFileArtifact } from "../src/render"

const BYTES = Buffer.from("PK\u0003\u0004 test payload", "utf8")

describe("file artifact wrapper", () => {
  it("round-trips the exact bytes, name and media type", () => {
    const html = buildFileArtifact({
      title: "Report",
      filename: "report.pdf",
      mediaType: "application/pdf",
      data: BYTES,
    })
    expect(html.startsWith("<!doctype html")).toBe(true)
    expect(html).toContain('data-openchat-file="1"')
    expect(html).toContain('id="openchat-file"')
    expect(parseFileArtifact(html)).toEqual({
      filename: "report.pdf",
      mediaType: "application/pdf",
      data: BYTES,
    })
  })

  it("escapes markup in the visible title and keeps the payload inert", () => {
    const html = buildFileArtifact({
      title: "<script>alert(1)</script>",
      filename: "x.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: Buffer.from("x"),
    })
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(parseFileArtifact(html)?.filename).toBe("x.docx")
  })

  it("returns null for an ordinary app artifact", () => {
    expect(parseFileArtifact("<!doctype html><html><body>app</body></html>")).toBeNull()
  })

  it("returns null for malformed JSON, a bad name and an oversized payload", () => {
    const broken = '<script type="application/json" id="openchat-file">{"filename":</script>'
    expect(parseFileArtifact(broken)).toBeNull()

    const badName = buildFileArtifact({
      title: "x",
      filename: "../escape.docx",
      mediaType: "application/pdf",
      data: BYTES,
    })
    expect(parseFileArtifact(badName)).toBeNull()

    const huge = buildFileArtifact({
      title: "x",
      filename: "big.pdf",
      mediaType: "application/pdf",
      data: Buffer.alloc(701 * 1024),
    })
    expect(parseFileArtifact(huge)).toBeNull()
  })
})
