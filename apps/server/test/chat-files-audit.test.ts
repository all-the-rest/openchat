import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { auditChatFiles, reportChatFileOrphans } from "../src/chat-files-audit"
import { ChatFilesStore } from "../src/chat-files-store"

const dirs: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-chat-audit-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function store(workspaceDir: string): ChatFilesStore {
  return new ChatFilesStore({
    workspaceDir,
    quotaPerChatBytes: 1024 * 1024,
    quotaTotalBytes: 4 * 1024 * 1024,
    maxFileBytes: 1024 * 1024,
  })
}

describe("chat files audit", () => {
  it("reports orphan directories, unindexed files and indexed files that are gone", async () => {
    const dir = await workspace()
    const files = store(dir)
    expect(await files.write("ses_known", { name: "kept.txt", bytes: Buffer.from("kept"), origin: "upload" }))
      .toMatchObject({ ok: true })
    expect(await files.write("ses_gone", { name: "gone.txt", bytes: Buffer.from("gone"), origin: "upload" }))
      .toMatchObject({ ok: true })

    // A crash between file write and index write leaves this behind.
    await writeFile(join(dir, "chats", "ses_known", "files", "loose.bin"), "loose")
    // A manual delete leaves the metadata row without a file.
    await rm(join(dir, "chats", "ses_gone", "files", "gone.txt"))
    // A chat directory the host no longer lists.
    await mkdir(join(dir, "chats", "ses_orphan", "files"), { recursive: true })
    await writeFile(join(dir, "chats", "ses_orphan", "files", "orphan.txt"), "orphan")

    const report = await reportChatFileOrphans(
      { workspaceDir: dir, sessionIDs: ["ses_known", "ses_gone"] },
      () => undefined,
    )
    expect(report.orphanDirs).toEqual(["ses_orphan"])
    expect(report.withoutMetadata.sort()).toEqual([
      "ses_known/files/loose.bin",
      "ses_orphan/files/orphan.txt",
    ])
    expect(report.withoutFile).toEqual(["ses_gone/files/gone.txt"])

    // The boot check only reports: every path is still there.
    await expect(readdir(join(dir, "chats", "ses_orphan", "files"))).resolves.toEqual([
      "orphan.txt",
    ])
    await expect(readdir(join(dir, "chats", "ses_known", "files"))).resolves.toContain("loose.bin")
  })

  it("logs one line per finding and nothing for a clean workspace", async () => {
    const dir = await workspace()
    await mkdir(join(dir, "chats", "ses_orphan", "files"), { recursive: true })
    await writeFile(join(dir, "chats", "ses_orphan", "files", "orphan.txt"), "orphan")
    const lines: string[] = []
    const report = await reportChatFileOrphans(
      { workspaceDir: dir, sessionIDs: [] },
      (line) => lines.push(line),
    )

    expect(report.orphanDirs).toEqual(["ses_orphan"])
    expect(lines).toEqual([
      "chat files: directory without a session: ses_orphan",
      "chat files: file without metadata: ses_orphan/files/orphan.txt",
    ])

    const empty = await workspace()
    expect(await auditChatFiles(empty)).toEqual({ withoutMetadata: [], withoutFile: [] })
    expect(await reportChatFileOrphans({ workspaceDir: empty, sessionIDs: [] }, () => undefined))
      .toEqual({ orphanDirs: [], withoutMetadata: [], withoutFile: [] })
  })

  it("keeps an agent-written file in the same list as an upload", async () => {
    const dir = await workspace()
    const files = store(dir)
    await files.write("ses_agent", { name: "filled.docx", bytes: Buffer.from("doc"), origin: "agent" })
    await files.write("ses_agent", { name: "template.docx", bytes: Buffer.from("tpl"), origin: "upload" })

    const listed = await files.list("ses_agent")
    expect(Object.fromEntries(listed.map((file) => [file.name, file.origin]))).toEqual({
      "filled.docx": "agent",
      "template.docx": "upload",
    })
    const usage = await files.usage("ses_agent")
    expect(usage.usedBytes).toBe(6)
    expect(usage.totalUsedBytes).toBe(6)
  })
})
