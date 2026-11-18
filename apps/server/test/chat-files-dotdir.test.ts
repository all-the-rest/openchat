import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { auditChatFiles, reportChatFileOrphans } from "../src/chat-files-audit"
import { totalIndexedBytes } from "../src/chat-files-index"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("chats scans: dot-directories", () => {
  it("never treats .memory as a session, a quota row or an orphan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openchat-memory-dotdir-"))
    dirs.push(workspace)
    const memory = join(workspace, "chats", ".memory")
    await mkdir(memory, { recursive: true })
    await writeFile(join(memory, "index.json"), JSON.stringify({ version: 1, files: [] }))
    await writeFile(join(memory, "facts.jsonl"), "{}\n")

    expect(await totalIndexedBytes(workspace)).toBe(0)
    expect(await auditChatFiles(workspace)).toEqual({ withoutMetadata: [], withoutFile: [] })

    const logged: string[] = []
    const report = await reportChatFileOrphans(
      { workspaceDir: workspace, sessionIDs: [] },
      (message) => logged.push(message),
    )
    expect(report.orphanDirs).toEqual([])
    expect(logged).toEqual([])
  })
})
