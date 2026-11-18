import { describe, expect, it } from "vitest"
import { formatArchive } from "../src/format"

describe("archive formatting", () => {
  it("summarises a listing and keeps unicode names", () => {
    const text = formatArchive({
      kind: "listing",
      zip: "bundle.zip",
      bytes: 2048,
      entries: [
        { name: "notes/", size: 0, compressedSize: 0, directory: true },
        { name: "notes/ü.txt", size: 1536, compressedSize: 512, directory: false },
      ],
      totals: {
        entries: 2,
        files: 1,
        directories: 1,
        uncompressedBytes: 1536,
        compressedBytes: 512,
      },
    })
    expect(text).toContain('Archive "bundle.zip" (2.0 KiB)')
    expect(text).toContain("2 entries — 1 file, 1 directory")
    expect(text).toContain("notes/ü.txt — 1.5 KiB")
    expect(text).toContain("notes/ — 0 B (directory)")
  })

  it("truncates a long entry name instead of flooding the result", () => {
    const long = `${"a".repeat(400)}.txt`
    const text = formatArchive({
      kind: "listing",
      zip: "bundle.zip",
      bytes: 1,
      entries: [{ name: long, size: 1, compressedSize: 1, directory: false }],
      totals: { entries: 1, files: 1, directories: 0, uncompressedBytes: 1, compressedBytes: 1 },
    })
    expect(text).toContain("…")
    expect(text.length).toBeLessThan(300)
  })

  it("names the extraction folder and its files", () => {
    const text = formatArchive({
      kind: "extraction",
      zip: "bundle.zip",
      directory: "bundle",
      files: [{ path: "notes/readme.txt", size: 14 }],
      bytes: 14,
    })
    expect(text).toContain('Extracted "bundle.zip" into files/bundle/')
    expect(text).toContain("notes/readme.txt — 14 B")
  })

  it("says so when the archive is empty", () => {
    const text = formatArchive({
      kind: "extraction",
      zip: "bundle.zip",
      directory: "bundle",
      files: [],
      bytes: 0,
    })
    expect(text).toContain("The archive had no files.")
  })
})
