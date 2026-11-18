import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { writeChatFile, writeChatOutputs } from "../src/chat-output"

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

describe("new chat document writer", () => {
  it("creates one file with 0600 and returns its name", async () => {
    const { root, files } = workspace()
    const result = await writeChatFile(root, "session-1/files/report.docx", new Uint8Array(Buffer.from("docx")))
    expect(result).toEqual({ ok: true, name: "report.docx" })
    expect(readFileSync(join(files, "report.docx")).toString()).toBe("docx")
    expect(statSync(join(files, "report.docx")).mode & 0o777).toBe(0o600)
  })

  it("suffixes a collision instead of overwriting", async () => {
    const { root, files } = workspace()
    writeFileSync(join(files, "report.docx"), "existing")
    const result = await writeChatFile(root, "session-1/files/report.docx", new Uint8Array(Buffer.from("new")))
    expect(result).toEqual({ ok: true, name: "report-1.docx" })
    expect(readFileSync(join(files, "report-1.docx")).toString()).toBe("new")
  })

  it("never follows a symlink at the target name", async () => {
    const { root, files } = workspace()
    const target = join(root, "outside.docx")
    writeFileSync(target, "outside")
    symlinkSync(target, join(files, "report.docx"))
    const result = await writeChatFile(root, "session-1/files/report.docx", new Uint8Array(Buffer.from("new")))
    expect(result).toEqual({ ok: true, name: "report-1.docx" })
    expect(readFileSync(target).toString()).toBe("outside")
  })

  it("refuses an unsafe path, an empty payload and a missing chat folder", async () => {
    const { root } = workspace()
    const bytes = new Uint8Array(Buffer.from("docx"))
    expect(await writeChatFile(root, "/etc/report.docx", bytes)).toEqual({
      ok: false,
      error: "chatPath: use a path inside WORKSPACE_DIR/chats",
    })
    expect(await writeChatFile(root, "session-2/files/report.docx", bytes)).toEqual({
      ok: false,
      error: "chatPath: the chat directory is not a safe directory",
    })
    expect(await writeChatFile(root, "session-1/files/report.docx", new Uint8Array([]))).toEqual({
      ok: false,
      error: "size: the generated file exceeds the chat file cap",
    })
  })
})
