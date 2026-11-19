import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatFilesResponse } from "@openchat/contracts"
import {
  auditChatFiles,
  createChatFilesStore,
  reportChatFiles,
  uploadChatFile,
} from "../src/chat-files"
import { CHATS_DIR_NAME } from "../src/chat-files-names"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const roots: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-files-route-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function serverWith(dir: string, env: Record<string, string> = {}): Promise<TestServer> {
  return makeServer({ env: { WORKSPACE_DIR: dir, ...env } })
}

async function seed(
  server: TestServer,
  sessionID: string,
  name: string,
  bytes: Buffer,
): Promise<void> {
  const store = createChatFilesStore(server.config)
  const result = await store.write(sessionID, { name, bytes, origin: "upload" })
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`)
}

describe("chat file routes", () => {
  it("requires authentication", async () => {
    const server = await serverWith(await workspace())
    const response = await server.app.request("/api/sessions/ses_one/files")
    expect(response.status).toBe(401)
  })

  it("lists, downloads and deletes a file", async () => {
    const dir = await workspace()
    const server = await serverWith(dir)
    const cookie = await login(server)
    await seed(server, "ses_one", "report.txt", Buffer.from("hello report"))

    const listed = await server.app.request("/api/sessions/ses_one/files", {
      headers: { cookie },
    })
    expect(listed.status).toBe(200)
    const body = await json<ChatFilesResponse>(listed)
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({
      name: "report.txt",
      displayName: "report.txt",
      size: 12,
      mime: "text/plain; charset=utf-8",
      origin: "upload",
    })
    expect(body.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(body.quota).toMatchObject({ usedBytes: 12, quotaBytes: 104_857_600 })

    const download = await server.app.request("/api/sessions/ses_one/files/report.txt", {
      headers: { cookie },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename="report.txt"; filename*=UTF-8''report.txt`,
    )
    expect(download.headers.get("x-content-type-options")).toBe("nosniff")
    expect(download.headers.get("cache-control")).toBe("no-store")
    expect(await download.text()).toBe("hello report")

    const removed = await server.app.request("/api/sessions/ses_one/files/report.txt", {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(removed.status).toBe(204)
    const after = await json<ChatFilesResponse>(
      await server.app.request("/api/sessions/ses_one/files", { headers: { cookie } }),
    )
    expect(after.files).toEqual([])
    await expect(stat(join(dir, CHATS_DIR_NAME, "ses_one", "files", "report.txt"))).rejects.toMatchObject(
      { code: "ENOENT" },
    )
  })

  it("answers 404 for an unknown file and 200 with an empty list for an unknown chat", async () => {
    const server = await serverWith(await workspace())
    const cookie = await login(server)
    const missing = await server.app.request("/api/sessions/ses_one/files/nope.txt", {
      headers: { cookie },
    })
    expect(missing.status).toBe(404)
    expect(await json(missing)).toEqual({
      error: { code: "file_unknown", message: "Unknown file" },
    })

    const empty = await server.app.request("/api/sessions/ses_other/files", {
      headers: { cookie },
    })
    expect(empty.status).toBe(200)
    const body = await json<ChatFilesResponse>(empty)
    expect(body.files).toEqual([])
  })

  it.each([
    "..%2F..%2Fetc%2Fpasswd",
    "%2Fetc%2Fpasswd",
    "..%2Fsecret.txt",
    ".hidden",
  ])("rejects the path attempt %s with 400", async (attempt) => {
    const server = await serverWith(await workspace())
    const cookie = await login(server)
    const download = await server.app.request(`/api/sessions/ses_one/files/${attempt}`, {
      headers: { cookie },
    })
    expect(download.status).toBe(400)
    const removed = await server.app.request(`/api/sessions/ses_one/files/${attempt}`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(removed.status).toBe(400)
  })

  it("answers 404 when a listed file is replaced by a symlink", async () => {
    const dir = await workspace()
    const server = await serverWith(dir)
    const cookie = await login(server)
    await seed(server, "ses_one", "report.txt", Buffer.from("safe"))
    const path = join(dir, CHATS_DIR_NAME, "ses_one", "files", "report.txt")
    await unlink(path)
    await symlink("/etc/passwd", path)

    const download = await server.app.request("/api/sessions/ses_one/files/report.txt", {
      headers: { cookie },
    })
    expect(download.status).toBe(404)
    const list = await json<ChatFilesResponse>(
      await server.app.request("/api/sessions/ses_one/files", { headers: { cookie } }),
    )
    expect(list.files).toEqual([])
  })

  it("keeps two chats isolated", async () => {
    const server = await serverWith(await workspace())
    const cookie = await login(server)
    await seed(server, "ses_a", "a.txt", Buffer.from("a"))
    await seed(server, "ses_b", "b.txt", Buffer.from("b"))

    const listA = await json<ChatFilesResponse>(
      await server.app.request("/api/sessions/ses_a/files", { headers: { cookie } }),
    )
    expect(listA.files.map((file) => file.name)).toEqual(["a.txt"])
    expect(
      (await server.app.request("/api/sessions/ses_a/files/b.txt", { headers: { cookie } })).status,
    ).toBe(404)
  })

  it("maps quota and oversize rejections to 413 before anything is written", async () => {
    const dir = await workspace()
    const server = await serverWith(dir, {
      WORKSPACE_QUOTA_PER_CHAT_BYTES: "10",
      WORKSPACE_QUOTA_TOTAL_BYTES: "10",
      WORKSPACE_MAX_FILE_BYTES: "8",
    })
    const store = createChatFilesStore(server.config)

    const tooLarge = await uploadChatFile(store, "ses_one", {
      name: "big.bin",
      bytes: Buffer.alloc(9),
      origin: "upload",
    })
    expect(tooLarge).toMatchObject({ ok: false, status: 413 })

    const first = await uploadChatFile(store, "ses_one", {
      name: "a.txt",
      bytes: Buffer.alloc(8),
      origin: "upload",
    })
    expect(first.ok).toBe(true)
    const overChat = await uploadChatFile(store, "ses_one", {
      name: "b.txt",
      bytes: Buffer.alloc(8),
      origin: "upload",
    })
    expect(overChat).toMatchObject({ ok: false, status: 413 })
    expect((await readdir(join(dir, CHATS_DIR_NAME, "ses_one", "files"))).sort()).toEqual([
      "a.txt",
    ])

    const overTotal = await uploadChatFile(store, "ses_two", {
      name: "c.txt",
      bytes: Buffer.alloc(8),
      origin: "upload",
    })
    expect(overTotal).toMatchObject({ ok: false, status: 413 })
    await expect(readdir(join(dir, CHATS_DIR_NAME, "ses_two"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("boot orphan report", () => {
  it("reports the three orphan classes and deletes nothing", async () => {
    const dir = await workspace()
    const server = await serverWith(dir)
    await seed(server, "ses_a", "kept.txt", Buffer.from("a"))
    await seed(server, "ses_b", "gone.txt", Buffer.from("b"))
    const filesDir = join(dir, CHATS_DIR_NAME, "ses_a", "files")
    await rm(join(filesDir, "kept.txt"))
    await writeFile(join(filesDir, "stray.txt"), "stray")
    await mkdir(join(dir, CHATS_DIR_NAME, "ses_orphan", "files"), { recursive: true })

    const report = await auditChatFiles(server.config, ["ses_a", "ses_b"])
    expect(report.withoutSession).toEqual(["ses_orphan"])
    expect(report.withoutMetadata).toEqual(["ses_a/stray.txt"])
    expect(report.withoutFile).toEqual(["ses_a/kept.txt"])

    const lines: string[] = []
    expect(reportChatFiles(report, (line) => lines.push(line))).toBe(true)
    const text = lines.join("\n")
    expect(text).toContain("ses_orphan")
    expect(text).toContain("ses_a/stray.txt")
    expect(text).toContain("not deleted")
    expect((await readdir(join(dir, CHATS_DIR_NAME))).sort()).toEqual([
      "ses_a",
      "ses_b",
      "ses_orphan",
    ])
    expect(await readFile(join(filesDir, "stray.txt"), "utf8")).toBe("stray")
  })

  it("logs nothing when the workspace is clean", async () => {
    const server = await serverWith(await workspace())
    const lines: string[] = []
    expect(reportChatFiles(await auditChatFiles(server.config, []), (line) => lines.push(line))).toBe(
      false,
    )
    expect(lines).toEqual([])
  })
})
