import { describe, expect, it } from "vitest"
import {
  ARTIFACT_FILE_MIME,
  ARTIFACT_HTML_MIME,
  ARTIFACT_PDF_MIME,
  artifactExtension,
  artifactKind,
  artifactMime,
  isArtifactImageMime,
} from "../src/artifacts/mime"

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])
const gif = (version = "89a") => new Uint8Array(Buffer.from(`GIF${version}rest`))
const webp = () => {
  const bytes = new Uint8Array(16)
  bytes.set(Buffer.from("RIFF"), 0)
  bytes.set(Buffer.from("WEBP"), 8)
  return bytes
}
const pdf = () => new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj\n"))
const html = (body = "<!doctype html><html></html>") => new Uint8Array(Buffer.from(body))

describe("artifact MIME sniffing", () => {
  it.each([
    ["png", png(), "image/png"],
    ["jpeg", jpeg(), "image/jpeg"],
    ["gif87a", gif("87a"), "image/gif"],
    ["gif89a", gif("89a"), "image/gif"],
    ["webp", webp(), "image/webp"],
    ["pdf", pdf(), ARTIFACT_PDF_MIME],
    ["doctype", html(), ARTIFACT_HTML_MIME],
    ["uppercase html", html("  <HTML lang='en'>"), ARTIFACT_HTML_MIME],
    ["bom", html("\uFEFF<!DOCTYPE HTML>"), ARTIFACT_HTML_MIME],
  ])("sniffs %s from its leading bytes", (_label, bytes, expected) => {
    expect(artifactMime(bytes)).toBe(expected)
  })

  it("keeps opaque bytes generic, including markup that is not a full document", () => {
    expect(artifactMime(new Uint8Array([1, 2, 3]))).toBe(ARTIFACT_FILE_MIME)
    expect(artifactMime(new Uint8Array())).toBe(ARTIFACT_FILE_MIME)
    expect(artifactMime(html("<svg onload=alert(1)>"))).toBe(ARTIFACT_FILE_MIME)
  })

  it("accepts only the four image MIME types", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isArtifactImageMime(mime)).toBe(true)
    }
    expect(isArtifactImageMime("image/svg+xml")).toBe(false)
    expect(isArtifactImageMime("text/html")).toBe(false)
  })

  it("maps MIME to a display kind and a download extension", () => {
    expect(artifactKind(undefined)).toBe("html")
    expect(artifactKind("text/html")).toBe("html")
    expect(artifactKind("image/png")).toBe("image")
    expect(artifactKind(ARTIFACT_PDF_MIME)).toBe("pdf")
    expect(artifactKind(ARTIFACT_FILE_MIME)).toBe("file")
    expect(artifactExtension("image/jpeg")).toBe(".jpg")
    expect(artifactExtension("image/webp")).toBe(".webp")
    expect(artifactExtension(ARTIFACT_PDF_MIME)).toBe(".pdf")
    expect(artifactExtension(undefined)).toBe(".html")
  })
})
