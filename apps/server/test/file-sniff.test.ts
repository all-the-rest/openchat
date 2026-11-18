import { describe, expect, it } from "vitest"
import { extensionMatches, sniffFile } from "../src/file-sniff"

const bytes = (value: string) => Buffer.from(value, "latin1")

const accepted: Array<[string, string, string, string]> = [
  ["plain text", "hello notes", "notes.txt", "text/plain; charset=utf-8"],
  ["markdown", "# Title", "notes.md", "text/plain; charset=utf-8"],
  ["png", "\x89PNG\r\n\x1a\nrest", "pic.png", "image/png"],
  ["jpeg", "\xff\xd8\xff\xe0rest", "pic.jpg", "image/jpeg"],
  ["gif", "GIF89arest", "pic.gif", "image/gif"],
  ["webp", "RIFF\x00\x00\x00\x00WEBPrest", "pic.webp", "image/webp"],
  ["pdf", "%PDF-1.7\nrest", "report.pdf", "application/pdf"],
  [
    "docx",
    "PK\x03\x04word/document.xmlrest",
    "report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "xlsx",
    "PK\x03\x04xl/workbook.xmlrest",
    "sheet.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    "pptx",
    "PK\x03\x04ppt/presentation.xmlrest",
    "deck.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["zip", "PK\x03\x04plain-entries", "bundle.zip", "application/zip"],
]

describe("file sniffing: accepted types", () => {
  it.each(accepted)("sniffs %s and stores the sniffed MIME", (_label, body, name, mime) => {
    const result = sniffFile(bytes(body))
    expect(result?.mime).toBe(mime)
    expect(extensionMatches(name, result?.kind ?? "text")).toBe(true)
  })

  it("detects the NUL boundary at 8 KiB", () => {
    const prefix = bytes("a".repeat(8191))
    expect(sniffFile(Buffer.concat([prefix, bytes("b")]))?.kind).toBe("text")
    expect(sniffFile(Buffer.concat([prefix, Buffer.from([0])]))).toBeNull()
    const afterSample = Buffer.concat([bytes("a".repeat(8192)), Buffer.from([0])])
    expect(sniffFile(afterSample)?.kind).toBe("text")
  })
})

describe("file sniffing: rejected bytes", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["html", bytes("<!DOCTYPE html><html><body>hi</body></html>")],
    ["svg", bytes("<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'/>")],
    ["script", bytes("<script>alert(1)</script>")],
    ["nul text", bytes("hello\x00world")],
    ["unknown binary", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])],
  ])("rejects %s", (_label, body) => {
    expect(sniffFile(body)).toBeNull()
  })

  it("does not mistake a webp with a missing RIFF tag", () => {
    expect(sniffFile(bytes("JUNK--------WEBP"))?.kind).toBe("text")
  })
})

describe("file sniffing: extension agreement", () => {
  it("rejects a mismatched extension", () => {
    const pdf = sniffFile(bytes("%PDF-1.7"))
    expect(pdf?.kind).toBe("pdf")
    expect(extensionMatches("fake.png", pdf?.kind ?? "text")).toBe(false)
  })

  it("rejects an extension that is not on the allowlist", () => {
    const text = sniffFile(bytes("plain"))
    expect(extensionMatches("page.html", text?.kind ?? "text")).toBe(false)
    expect(extensionMatches("page.svg", text?.kind ?? "text")).toBe(false)
    expect(extensionMatches("payload.exe", text?.kind ?? "text")).toBe(false)
  })

  it("compares extensions case-insensitively", () => {
    expect(extensionMatches("PHOTO.PNG", "png")).toBe(true)
  })
})
