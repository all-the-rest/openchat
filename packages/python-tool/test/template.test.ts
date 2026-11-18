import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readTemplate } from "../src/template"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "python-tool-template-"))
  created.push(root)
  const files = join(root, "chats", "session-1", "files")
  mkdirSync(files, { recursive: true, mode: 0o700 })
  writeFileSync(join(files, "invoice.dotx"), Buffer.from("PK\x03\x04fake-dotx"))
  writeFileSync(join(files, "huge.docx"), Buffer.alloc(9 * 1024 * 1024, 1))
  return root
}

describe("template path guard", () => {
  it("reads a template inside chats with its session and name", async () => {
    const root = workspace()
    const result = await readTemplate(root, "session-1/files/invoice.dotx")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sessionID).toBe("session-1")
      expect(result.name).toBe("invoice.dotx")
      expect(Buffer.from(result.bytes).toString()).toContain("fake-dotx")
    }
  })

  it("refuses absolute paths and traversal even when the file exists", async () => {
    const root = workspace()
    const outside = join(root, "secret.dotx")
    writeFileSync(outside, Buffer.from("PK\x03\x04secret"))
    for (const path of [
      outside,
      "/etc/passwd",
      "../secret.dotx",
      "session-1/files/../../secret.dotx",
      "session-1/files/../../../secret.dotx",
      "session-1/other/invoice.dotx",
      "session-1/files/invoice.docx/../invoice.dotx",
    ]) {
      const result = await readTemplate(root, path)
      expect(result.ok, path).toBe(false)
      if (!result.ok) expect(result.code).toBe("invalid_path")
    }
  })

  it("refuses a symlinked template and a symlinked files directory", async () => {
    const root = workspace()
    const files = join(root, "chats", "session-1", "files")
    symlinkSync(join(files, "invoice.dotx"), join(files, "linked.dotx"))
    expect((await readTemplate(root, "session-1/files/linked.dotx")).ok).toBe(false)

    const second = join(root, "chats", "session-2")
    mkdirSync(second, { recursive: true })
    symlinkSync(files, join(second, "files"))
    expect((await readTemplate(root, "session-2/files/invoice.dotx")).ok).toBe(false)
  })

  it("caps the template size before reading it", async () => {
    const root = workspace()
    const result = await readTemplate(root, "session-1/files/huge.docx")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("too_large")
  })

  it("returns invalid_path for a missing chat or file", async () => {
    const root = workspace()
    for (const path of ["missing/files/invoice.dotx", "session-1/files/missing.dotx"]) {
      const result = await readTemplate(root, path)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("invalid_path")
    }
  })
})
