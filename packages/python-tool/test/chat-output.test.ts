import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { writeChatOutputs } from "../src/chat-output"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): { root: string; files: string } {
  const root = mkdtempSync(join(tmpdir(), "python-tool-output-"))
  created.push(root)
  const files = join(root, "chats", "session-1", "files")
  mkdirSync(files, { recursive: true, mode: 0o700 })
  writeFileSync(join(files, "invoice.dotx"), Buffer.from("template"))
  return { root, files }
}

describe("chat output writer", () => {
  it("writes both outputs beside the template and reports their names", async () => {
    const { root, files } = workspace()
    const result = await writeChatOutputs(root, "session-1/files/invoice.dotx", "invoice", [
      { name: "invoice.docx", bytes: new Uint8Array(Buffer.from("filled")) },
      { name: "invoice.pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.7")) },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.names).toEqual(["invoice.docx", "invoice.pdf"])
    expect(readFileSync(join(files, "invoice.docx")).toString()).toBe("filled")
    expect(readFileSync(join(files, "invoice.pdf")).toString()).toBe("%PDF-1.7")
  })

  it("uses a collision suffix instead of overwriting", async () => {
    const { root, files } = workspace()
    writeFileSync(join(files, "invoice.pdf"), "existing")
    const result = await writeChatOutputs(root, "session-1/files/invoice.dotx", undefined, [
      { name: "invoice.pdf", bytes: new Uint8Array(Buffer.from("new")) },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.names).toEqual(["invoice-1.pdf"])
    expect(readFileSync(join(files, "invoice.pdf")).toString()).toBe("existing")
    expect(readFileSync(join(files, "invoice-1.pdf")).toString()).toBe("new")
  })

  it("never follows an existing symlink at the output name", async () => {
    const { root, files } = workspace()
    const target = join(root, "outside.txt")
    writeFileSync(target, "outside")
    symlinkSync(target, join(files, "invoice.pdf"))
    const result = await writeChatOutputs(root, "session-1/files/invoice.dotx", undefined, [
      { name: "invoice.pdf", bytes: new Uint8Array(Buffer.from("new")) },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.names).toEqual(["invoice-1.pdf"])
    expect(readFileSync(target).toString()).toBe("outside")
  })

  it("refuses a path outside chats and an empty payload", async () => {
    const { root } = workspace()
    expect((await writeChatOutputs(root, "/etc/passwd", undefined, [
      { name: "a.pdf", bytes: new Uint8Array([1]) },
    ])).ok).toBe(false)
    expect((await writeChatOutputs(root, "session-1/files/invoice.dotx", undefined, [
      { name: "a.pdf", bytes: new Uint8Array([]) },
    ])).ok).toBe(false)
  })
})
