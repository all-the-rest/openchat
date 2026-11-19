import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile, link } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CHATS_DIR_NAME } from "../src/chat-files-names"
import { auditChatFiles } from "../src/chat-files-audit"
import { ChatFilesStore } from "../src/chat-files-store"
import type { ChatFilesStoreOptions } from "../src/chat-files-store"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-files-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

function store(
  workspaceDir: string,
  overrides: Partial<ChatFilesStoreOptions> = {},
): ChatFilesStore {
  return new ChatFilesStore({
    workspaceDir,
    quotaPerChatBytes: 1024,
    quotaTotalBytes: 4096,
    maxFileBytes: 512,
    ...overrides,
  })
}

const DOCX = Buffer.from("PK\u0003\u0004 fake docx bytes")

describe("chat files store", () => {
  it("round-trips uploads and agent output with metadata", async () => {
    const dir = await root()
    const files = store(dir)
    const upload = await files.write("ses_one", {
      name: "template.docx",
      bytes: DOCX,
      origin: "upload",
    })
    expect(upload.ok).toBe(true)
    if (!upload.ok) return
    expect(upload.file).toMatchObject({
      name: "template.docx",
      displayName: "template.docx",
      size: DOCX.byteLength,
      origin: "upload",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: createHash("sha256").update(DOCX).digest("hex"),
    })

    const output = await files.write("ses_one", {
      name: "filled.txt",
      bytes: Buffer.from("done"),
      origin: "agent",
    })
    expect(output.ok).toBe(true)
    expect((await files.list("ses_one")).map((file) => file.name).sort()).toEqual([
      "filled.txt",
      "template.docx",
    ])

    const read = await files.read("ses_one", "template.docx")
    expect(read?.bytes.equals(DOCX)).toBe(true)
    expect(read?.file.sha256).toBe(upload.file.sha256)

    expect((await files.list("ses_one")).every((file) => file.origin !== undefined)).toBe(true)
    expect(await files.remove("ses_one", "template.docx")).toBe("removed")
    expect(await files.read("ses_one", "template.docx")).toBeNull()
    expect((await files.list("ses_one")).map((file) => file.name)).toEqual(["filled.txt"])
  })

  it("creates the directory only on the first successful write", async () => {
    const dir = await root()
    const files = store(dir, { quotaPerChatBytes: 4 })
    const rejected = await files.write("ses_empty", {
      name: "too-big.bin",
      bytes: Buffer.from("12345"),
      origin: "upload",
    })
    expect(rejected).toEqual({ ok: false, reason: "quota-chat" })
    await expect(readdir(join(dir, CHATS_DIR_NAME))).rejects.toMatchObject({ code: "ENOENT" })

    expect(
      (await files.write("ses_empty", { name: "ok.txt", bytes: Buffer.from("1234"), origin: "upload" }))
        .ok,
    ).toBe(true)
    const info = await stat(join(dir, CHATS_DIR_NAME, "ses_empty"))
    const filesDir = await stat(join(dir, CHATS_DIR_NAME, "ses_empty", "files"))
    expect(info.mode & 0o777).toBe(0o700)
    expect(filesDir.mode & 0o777).toBe(0o700)
    const file = await stat(join(dir, CHATS_DIR_NAME, "ses_empty", "files", "ok.txt"))
    expect(file.mode & 0o777).toBe(0o600)
  })

  it.each([
    "../escape.txt",
    "/etc/passwd",
    "..\\escape.txt",
    "..",
    ".",
    ".hidden",
    " name.txt",
    "a/b.txt",
  ])("rejects the relative-path attempt %s without writing", async (name) => {
    const dir = await root()
    const files = store(dir)
    const result = await files.write("ses_one", { name, bytes: DOCX, origin: "upload" })
    expect(result).toEqual({ ok: false, reason: "invalid-name" })
    await expect(readdir(join(dir, CHATS_DIR_NAME))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("never reads or lists a file replaced by a symlink to /etc/passwd", async () => {
    const dir = await root()
    const files = store(dir)
    const created = await files.write("ses_one", {
      name: "report.txt",
      bytes: Buffer.from("safe"),
      origin: "agent",
    })
    expect(created.ok).toBe(true)
    const path = join(dir, CHATS_DIR_NAME, "ses_one", "files", "report.txt")
    await unlink(path)
    await symlink("/etc/passwd", path)

    expect(await files.read("ses_one", "report.txt")).toBeNull()
    expect(await files.list("ses_one")).toEqual([])
  })

  it("does not write through a symlink that occupies the target name", async () => {
    const dir = await root()
    const files = store(dir)
    const chatDir = join(dir, CHATS_DIR_NAME, "ses_one", "files")
    await mkdir(chatDir, { recursive: true, mode: 0o700 })
    await symlink("/etc/passwd", join(chatDir, "report.txt"))

    const created = await files.write("ses_one", {
      name: "report.txt",
      bytes: Buffer.from("safe"),
      origin: "agent",
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.file.name).toBe("report-2.txt")
    expect(await readFile("/etc/passwd", "utf8")).not.toContain("safe")
    expect(await readFile(join(chatDir, "report-2.txt"), "utf8")).toBe("safe")
  })

  it("rejects a file with more than one hard link", async () => {
    const dir = await root()
    const files = store(dir)
    expect((await files.write("ses_one", { name: "report.txt", bytes: DOCX, origin: "agent" })).ok).toBe(
      true,
    )
    const filesDir = join(dir, CHATS_DIR_NAME, "ses_one", "files")
    await link(join(filesDir, "report.txt"), join(filesDir, "alias.txt"))

    expect(await files.read("ses_one", "report.txt")).toBeNull()
    expect(await files.list("ses_one")).toEqual([])
  })

  it("enforces the per-chat quota before writing and leaves nothing behind", async () => {
    const dir = await root()
    const files = store(dir, { quotaPerChatBytes: 10, quotaTotalBytes: 1000 })
    expect((await files.write("ses_one", { name: "a.txt", bytes: Buffer.alloc(8), origin: "upload" })).ok).toBe(true)
    const result = await files.write("ses_one", {
      name: "b.txt",
      bytes: Buffer.alloc(8),
      origin: "upload",
    })
    expect(result).toEqual({ ok: false, reason: "quota-chat" })
    expect((await readdir(join(dir, CHATS_DIR_NAME, "ses_one", "files"))).sort()).toEqual([
      "a.txt",
    ])
    expect(await files.list("ses_one")).toHaveLength(1)
  })

  it("enforces the workspace-wide quota before creating a second chat", async () => {
    const dir = await root()
    const files = store(dir, { quotaPerChatBytes: 100, quotaTotalBytes: 10 })
    expect((await files.write("ses_one", { name: "a.txt", bytes: Buffer.alloc(8), origin: "upload" })).ok).toBe(true)
    const result = await files.write("ses_two", {
      name: "b.txt",
      bytes: Buffer.alloc(8),
      origin: "upload",
    })
    expect(result).toEqual({ ok: false, reason: "quota-total" })
    await expect(readdir(join(dir, CHATS_DIR_NAME, "ses_two"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("keeps two chats isolated and deletes only one directory", async () => {
    const dir = await root()
    const files = store(dir)
    expect((await files.write("ses_a", { name: "a.txt", bytes: Buffer.from("a"), origin: "upload" })).ok).toBe(true)
    expect((await files.write("ses_b", { name: "b.txt", bytes: Buffer.from("b"), origin: "upload" })).ok).toBe(true)

    expect(await files.read("ses_a", "b.txt")).toBeNull()
    expect(await files.read("ses_b", "a.txt")).toBeNull()
    expect((await files.list("ses_a")).map((file) => file.name)).toEqual(["a.txt"])
    expect((await files.list("ses_b")).map((file) => file.name)).toEqual(["b.txt"])

    expect(await files.deleteChat("ses_a")).toBe(true)
    await expect(readdir(join(dir, CHATS_DIR_NAME, "ses_a"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect((await files.list("ses_b")).map((file) => file.name)).toEqual(["b.txt"])
  })

  it("refuses a chat directory that is a symlink", async () => {
    const dir = await root()
    const outside = await root()
    await mkdir(join(outside, "files"), { recursive: true })
    await writeFile(join(outside, "files", "secret.txt"), "secret")
    await mkdir(join(dir, CHATS_DIR_NAME), { recursive: true })
    await symlink(outside, join(dir, CHATS_DIR_NAME, "ses_escape"))

    const files = store(dir)
    expect(await files.list("ses_escape")).toEqual([])
    expect((await files.usage("ses_escape")).usedBytes).toBe(0)
    expect(await files.deleteChat("ses_escape")).toBe(false)
    expect(await readFile(join(outside, "files", "secret.txt"), "utf8")).toBe("secret")
  })

  it("reports orphan directories, unindexed files and missing files without deleting", async () => {
    const dir = await root()
    const files = store(dir)
    expect((await files.write("ses_a", { name: "kept.txt", bytes: Buffer.from("a"), origin: "upload" })).ok).toBe(true)
    expect((await files.write("ses_b", { name: "gone.txt", bytes: Buffer.from("b"), origin: "upload" })).ok).toBe(true)

    await writeFile(join(dir, CHATS_DIR_NAME, "ses_a", "files", "stray.txt"), "stray")
    await rm(join(dir, CHATS_DIR_NAME, "ses_a", "files", "kept.txt"))
    await mkdir(join(dir, CHATS_DIR_NAME, "ses_orphan", "files"), { recursive: true })

    const report = await auditChatFiles(dir, ["ses_a", "ses_b"], (sessionID) =>
      files.readIndex(sessionID),
    )
    expect(report.withoutSession).toEqual(["ses_orphan"])
    expect(report.withoutMetadata).toEqual(["ses_a/stray.txt"])
    expect(report.withoutFile).toEqual(["ses_a/kept.txt"])

    expect((await readdir(join(dir, CHATS_DIR_NAME))).sort()).toEqual([
      "ses_a",
      "ses_b",
      "ses_orphan",
    ])
    expect(await readFile(join(dir, CHATS_DIR_NAME, "ses_a", "files", "stray.txt"), "utf8")).toBe(
      "stray",
    )
  })
})
