import { CHAT_FILE_MAX_BYTES, CHAT_QUOTA_PER_CHAT_BYTES } from "@openchat/contracts"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ArchiveRunner } from "../src/archive-types"
import {
  archiveParts,
  chatUsedBytes,
  extractArchive,
  listArchive,
  resolveArchiveSource,
} from "../src/archive"
import type { PythonRunner } from "../src/runner"
import { runDocumentTool } from "../src/tool"

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): { root: string; files: string; zip: string } {
  const root = mkdtempSync(join(tmpdir(), "python-tool-archive-"))
  created.push(root)
  const files = join(root, "chats", "session-1", "files")
  mkdirSync(files, { recursive: true, mode: 0o700 })
  const zip = join(files, "bundle.zip")
  writeFileSync(zip, Buffer.from("PK\x03\x04fake archive", "latin1"))
  return { root, files, zip }
}

const LISTING = {
  kind: "listing" as const,
  bytes: 18,
  entries: [{ name: "readme.txt", size: 5, compressedSize: 5, directory: false }],
  totals: { entries: 1, files: 1, directories: 0, uncompressedBytes: 5, compressedBytes: 5 },
}

const EXTRACTION = {
  kind: "extraction" as const,
  directory: "bundle",
  files: [{ path: "readme.txt", size: 5 }],
  bytes: 5,
}

function archiveRunner(
  calls: Array<{ tool: string; input: Record<string, unknown> }> = [],
): ArchiveRunner {
  return async (tool, input) => {
    calls.push({ tool, input })
    return { ok: true, value: tool === "archive_list" ? LISTING : EXTRACTION }
  }
}

const python: PythonRunner = async () => {
  throw new Error("the archive tools must not use the file runner")
}

describe("archive path rules", () => {
  it("accepts exactly <sessionID>/files/<name>.zip", () => {
    expect(archiveParts("session-1/files/bundle.zip")).toEqual({
      sessionID: "session-1",
      name: "bundle.zip",
    })
    expect(archiveParts("session-1/files/Ünïcode.zip")?.name).toBe("Ünïcode.zip")
  })

  it("rejects absolute, nested, other folders and traversal", () => {
    for (const path of [
      "/workspace/chats/session-1/files/bundle.zip",
      "session-1/files/nested/bundle.zip",
      "session-1/other/bundle.zip",
      "session-1/files/../bundle.zip",
      "session-1/files/bundle.rar",
      "session-1/files/.hidden.zip",
      "session-1/files/bundle.zip ",
      "bundle.zip",
    ]) {
      expect(archiveParts(path), path).toBeNull()
    }
  })

  it("resolves only a regular, singly-linked file under the chat folder", async () => {
    const { root, files, zip } = workspace()
    const source = await resolveArchiveSource(root, "session-1/files/bundle.zip")
    expect(source).toMatchObject({ ok: true, name: "bundle.zip" })
    if (source.ok) expect(source.path).toBe(await realpath(zip))

    const outside = join(root, "outside.zip")
    writeFileSync(outside, "PK\x03\x04")
    symlinkSync(outside, join(files, "link.zip"))
    expect(await resolveArchiveSource(root, "session-1/files/link.zip")).toEqual({
      ok: false,
      error: "zipPath: not a regular file",
    })

    linkSync(zip, join(files, "hard.zip"))
    expect(await resolveArchiveSource(root, "session-1/files/hard.zip")).toEqual({
      ok: false,
      error: "zipPath: not a regular file",
    })

    writeFileSync(join(files, "empty.zip"), "")
    expect(await resolveArchiveSource(root, "session-1/files/empty.zip")).toEqual({
      ok: false,
      error: "zipPath: the file is empty",
    })

    writeFileSync(join(files, "huge.zip"), Buffer.alloc(1))
    truncateSync(join(files, "huge.zip"), CHAT_FILE_MAX_BYTES + 1)
    expect(await resolveArchiveSource(root, "session-1/files/huge.zip")).toEqual({
      ok: false,
      error: "zipPath: larger than the 20 MiB chat file cap",
    })
  })
})

describe("chat usage accounting", () => {
  it("sums nested files and ignores symlinks", async () => {
    const { root, files } = workspace()
    writeFileSync(join(files, "one.txt"), "12345")
    mkdirSync(join(files, "extracted", "nested"), { recursive: true })
    writeFileSync(join(files, "extracted", "nested", "two.txt"), "123")
    symlinkSync("/etc/passwd", join(files, "outside.txt"))
    expect(await chatUsedBytes(files)).toBe(16 + 5 + 3)
    expect(await chatUsedBytes(join(root, "missing"))).toBeNull()
  })
})

describe("archive tools", () => {
  it("lists the resolved path and names the archive after the chat file", async () => {
    const { root, zip } = workspace()
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
    const result = await listArchive(root, archiveRunner(calls), "session-1/files/bundle.zip")
    expect(result).toEqual({ ok: true, value: { ...LISTING, zip: "bundle.zip" } })
    expect(calls).toEqual([{ tool: "archive_list", input: { path: await realpath(zip) } }])
  })

  it("passes the resolved folder, the used bytes and both caps to extraction", async () => {
    const { root, files, zip } = workspace()
    writeFileSync(join(files, "existing.txt"), "12345")
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
    const result = await extractArchive(root, archiveRunner(calls), {
      zipPath: "session-1/files/bundle.zip",
      directory: "bundle",
    })
    expect(result).toEqual({ ok: true, value: { ...EXTRACTION, zip: "bundle.zip" } })
    expect(calls).toEqual([
      {
        tool: "archive_extract",
        input: {
          path: await realpath(zip),
          destination: await realpath(files),
          directory: "bundle",
          usedBytes: 16 + 5,
          quotaBytes: CHAT_QUOTA_PER_CHAT_BYTES,
          maxFileBytes: CHAT_FILE_MAX_BYTES,
        },
      },
    ])
  })

  it("returns the runner's fixed error unchanged", async () => {
    const { root } = workspace()
    const runner: ArchiveRunner = async () => ({ ok: false, error: "archive: refused as a likely zip bomb" })
    expect(await listArchive(root, runner, "session-1/files/bundle.zip")).toEqual({
      ok: false,
      error: "archive: refused as a likely zip bomb",
    })
  })

  it("dispatches through the tool layer and validates before any runner call", async () => {
    const { root } = workspace()
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
    const deps = {
      bffUrl: "http://bff.example",
      token: "token-0123456789",
      runner: python,
      archiveRunner: archiveRunner(calls),
      workspaceDir: root,
    }
    const rejected = await runDocumentTool(
      "archive_extract",
      { zipPath: "/etc/passwd.zip", directory: "bundle" },
      deps,
    )
    expect(rejected.ok).toBe(false)
    expect(calls).toEqual([])

    const ok = await runDocumentTool(
      "archive_extract",
      { zipPath: "session-1/files/bundle.zip", directory: "bundle" },
      deps,
    )
    expect(ok.ok).toBe(true)
    expect(calls.map((call) => call.tool)).toEqual(["archive_extract"])
  })

  it("refuses without a workspace before touching the runner", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
    const result = await runDocumentTool(
      "archive_list",
      { zipPath: "session-1/files/bundle.zip" },
      {
        bffUrl: "http://bff.example",
        token: "token-0123456789",
        runner: python,
        archiveRunner: archiveRunner(calls),
      },
    )
    expect(result).toEqual({ ok: false, error: "zipPath: WORKSPACE_DIR is not configured" })
    expect(calls).toEqual([])
  })
})
