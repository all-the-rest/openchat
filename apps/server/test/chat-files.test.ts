import { createHash } from "node:crypto"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatFileInfo, ChatFilesResponse } from "@openchat/contracts"
import { deleteChatFiles } from "../src/chat-files-audit"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const dirs: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-chat-files-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const SESSION = "ses_files_1"

async function serverWith(overrides: Record<string, string> = {}): Promise<{
  server: TestServer
  cookie: string
  dir: string
}> {
  const dir = await workspace()
  const server = makeServer({ env: { WORKSPACE_DIR: dir, ...overrides } })
  return { server, cookie: await login(server), dir }
}

function filesPath(sessionID = SESSION): string {
  return `/api/sessions/${sessionID}/files`
}

async function upload(
  server: TestServer,
  cookie: string,
  name: string,
  body: string,
  sessionID = SESSION,
): Promise<Response> {
  return await server.app.request(`${filesPath(sessionID)}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream" },
    body,
  })
}

async function list(
  server: TestServer,
  cookie: string,
  sessionID = SESSION,
): Promise<Response> {
  return await server.app.request(filesPath(sessionID), { headers: { cookie } })
}

describe("chat files: round trip", () => {
  it("uploads, lists, downloads and deletes one file", async () => {
    const { server, cookie, dir } = await serverWith()
    const bytes = Buffer.from("Quarterly report template", "utf8")

    const created = await upload(server, cookie, "template.docx", bytes.toString("utf8"))
    expect(created.status).toBe(201)
    const file = await json<ChatFileInfo>(created)
    expect(file).toMatchObject({
      name: "template.docx",
      displayName: "template.docx",
      size: bytes.byteLength,
      origin: "upload",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })

    const listed = await list(server, cookie)
    expect(listed.status).toBe(200)
    const body = await json<ChatFilesResponse>(listed)
    expect(body.files).toHaveLength(1)
    expect(body.files[0]?.sha256).toBe(file.sha256)
    expect(body.quota).toMatchObject({
      usedBytes: bytes.byteLength,
      quotaBytes: 104_857_600,
      totalUsedBytes: bytes.byteLength,
      totalQuotaBytes: 1_073_741_824,
    })

    const download = await server.app.request(`${filesPath()}/template.docx`, {
      headers: { cookie },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get("content-type")).toBe(file.mime)
    expect(download.headers.get("content-disposition")).toContain('attachment; filename="template.docx"')
    expect(download.headers.get("x-content-type-options")).toBe("nosniff")
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)

    const removed = await server.app.request(`${filesPath()}/template.docx`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(removed.status).toBe(204)
    expect((await json<ChatFilesResponse>(await list(server, cookie))).files).toEqual([])
    await expect(readdir(join(dir, "chats", SESSION, "files"))).resolves.toEqual([])
  })

  it("enforces 0700 directories and 0600 files, even on a pre-existing chat", async () => {
    const { server, cookie, dir } = await serverWith()
    const chatDir = join(dir, "chats", SESSION)
    await mkdir(join(chatDir, "files"), { recursive: true, mode: 0o755 })
    await chmod(chatDir, 0o755)
    await chmod(join(chatDir, "files"), 0o755)

    expect((await upload(server, cookie, "mode.txt", "bits")).status).toBe(201)
    const mode = async (path: string) => (await stat(path)).mode & 0o777
    expect(await mode(chatDir)).toBe(0o700)
    expect(await mode(join(chatDir, "files"))).toBe(0o700)
    expect(await mode(join(chatDir, "files", "mode.txt"))).toBe(0o600)
    expect(await mode(join(chatDir, "index.json"))).toBe(0o600)
  })

  it("keeps every file of one chat while another chat stays empty", async () => {
    const { server, cookie } = await serverWith()
    await upload(server, cookie, "a.txt", "alpha")
    await upload(server, cookie, "b.txt", "bravo", "ses_files_2")

    const first = await json<ChatFilesResponse>(await list(server, cookie))
    const second = await json<ChatFilesResponse>(await list(server, cookie, "ses_files_2"))
    expect(first.files.map((file) => file.name)).toEqual(["a.txt"])
    expect(second.files.map((file) => file.name)).toEqual(["b.txt"])

    const crossRead = await server.app.request(`${filesPath("ses_files_2")}/a.txt`, {
      headers: { cookie },
    })
    expect(crossRead.status).toBe(404)
  })

  it("never overwrites a name: the second upload gets a suffix", async () => {
    const { server, cookie } = await serverWith()
    const first = await json<ChatFileInfo>(await upload(server, cookie, "notes.txt", "one"))
    const second = await json<ChatFileInfo>(await upload(server, cookie, "notes.txt", "two"))

    expect(first.name).toBe("notes.txt")
    expect(second.name).toBe("notes-1.txt")
    expect(second.displayName).toBe("notes (1).txt")
    const body = await json<ChatFilesResponse>(await list(server, cookie))
    expect(body.files.map((file) => file.name).sort()).toEqual(["notes-1.txt", "notes.txt"])
  })

  it("gives up with 409 instead of indexing a name the suffix would overrun", async () => {
    const { server, cookie } = await serverWith()
    const long = `${"a".repeat(196)}.txt`
    expect(long).toHaveLength(200)
    expect((await upload(server, cookie, long, "one")).status).toBe(201)
    const second = await upload(server, cookie, long, "two")
    expect(second.status).toBe(409)
    expect(await json(second)).toMatchObject({ error: { code: "name_conflict" } })
  })

  it("requires a session for every route", async () => {
    const { server, cookie } = await serverWith()
    await upload(server, cookie, "a.txt", "alpha")
    const requests: Array<[string, string]> = [
      [filesPath(), "GET"],
      [`${filesPath()}/a.txt`, "GET"],
      [`${filesPath()}/a.txt`, "DELETE"],
      [filesPath(), "POST"],
    ]
    for (const [path, method] of requests) {
      const response = await server.app.request(path, {
        method,
        headers: method === "GET" ? {} : { "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      })
      expect(response.status).toBe(401)
    }
  })
})

describe("chat files: path guards", () => {
  it.each([
    "../escape.txt",
    "../../etc/passwd",
    "..",
    "/etc/passwd",
    "/tmp/absolute.txt",
    "nested/dir.txt",
    "nested\\dir.txt",
    ".hidden",
    " leading.txt",
    "trailing.txt ",
    "",
  ])("rejects the name %j with 400", async (name) => {
    const { server, cookie, dir } = await serverWith()
    const response = await upload(server, cookie, name, "payload")
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: expect.stringMatching(/invalid/) } })
    await expect(lstat(join(dir, "chats"))).rejects.toThrow()
  })

  it("rejects traversal and absolute paths on download and delete too", async () => {
    const { server, cookie } = await serverWith()
    await upload(server, cookie, "kept.txt", "payload")

    for (const probe of ["..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "..%5C..%5Cetc"]) {
      const read = await server.app.request(`${filesPath()}/${probe}`, { headers: { cookie } })
      expect(read.status).toBe(400)
      const removed = await server.app.request(`${filesPath()}/${probe}`, {
        method: "DELETE",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
      expect(removed.status).toBe(400)
    }
    // The rejected probes did not consume the valid file.
    expect((await json<ChatFilesResponse>(await list(server, cookie))).files).toHaveLength(1)
  })

  it("rejects a symlink that points at /etc/passwd", async () => {
    const { server, cookie, dir } = await serverWith()
    const written = await json<ChatFileInfo>(await upload(server, cookie, "report.txt", "safe"))
    const chatDir = join(dir, "chats", SESSION)

    await unlink(join(chatDir, "files", "report.txt"))
    await symlink("/etc/passwd", join(chatDir, "files", "report.txt"))
    // Keep the metadata row, so only the filesystem check can reject the read.
    const index = JSON.parse(await readFile(join(chatDir, "index.json"), "utf8")) as {
      files: ChatFileInfo[]
    }
    expect(index.files[0]?.sha256).toBe(written.sha256)

    const download = await server.app.request(`${filesPath()}/report.txt`, { headers: { cookie } })
    expect(download.status).toBe(404)
    const body = await json<ChatFilesResponse>(await list(server, cookie))
    expect(body.files).toEqual([])
  })

  it("rejects a hardlinked file", async () => {
    const { server, cookie, dir } = await serverWith()
    await upload(server, cookie, "linked.txt", "payload")
    const chatDir = join(dir, "chats", SESSION)
    await link(join(chatDir, "files", "linked.txt"), join(chatDir, "files", "second-link.txt"))

    const download = await server.app.request(`${filesPath()}/linked.txt`, { headers: { cookie } })
    expect(download.status).toBe(404)
  })
})

describe("chat files: quota", () => {
  it("rejects an upload above the per-chat quota with 413 and writes nothing", async () => {
    const { server, cookie, dir } = await serverWith({
      WORKSPACE_QUOTA_PER_CHAT_BYTES: "8",
      WORKSPACE_QUOTA_TOTAL_BYTES: "1024",
    })

    const response = await upload(server, cookie, "big.txt", "nine-bytes")
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: "quota_exceeded" } })
    // No directory, no index, no partial file.
    await expect(lstat(join(dir, "chats"))).rejects.toThrow()
  })

  it("rejects the write that would cross the workspace total", async () => {
    const { server, cookie, dir } = await serverWith({
      WORKSPACE_QUOTA_PER_CHAT_BYTES: "1024",
      WORKSPACE_QUOTA_TOTAL_BYTES: "6",
    })
    expect((await upload(server, cookie, "one.txt", "12345")).status).toBe(201)
    const rejected = await upload(server, cookie, "two.txt", "123456", "ses_files_2")
    expect(rejected.status).toBe(413)
    expect(await json(rejected)).toMatchObject({ error: { code: "quota_exceeded" } })
    await expect(lstat(join(dir, "chats", "ses_files_2"))).rejects.toThrow()
  })

  it("rejects a file above WORKSPACE_MAX_FILE_BYTES with 413", async () => {
    const { server, cookie } = await serverWith({ WORKSPACE_MAX_FILE_BYTES: "4" })
    const response = await upload(server, cookie, "five.txt", "12345")
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: "payload_too_large" } })
  })
})

describe("chat files: delete", () => {
  it("removes only the deleted chat's directory", async () => {
    const { server, cookie, dir } = await serverWith()
    await upload(server, cookie, "a.txt", "alpha")
    await upload(server, cookie, "b.txt", "bravo", "ses_files_2")
    await upload(server, cookie, "c.txt", "charlie", "ses_files_3")

    expect(await deleteChatFiles(dir, SESSION)).toBe(true)

    const remaining = await readdir(join(dir, "chats"))
    expect(remaining.sort()).toEqual(["ses_files_2", "ses_files_3"])
    expect((await json<ChatFilesResponse>(await list(server, cookie, "ses_files_2"))).files).toHaveLength(1)
  })

  it("does not follow a chat directory that was replaced by a symlink", async () => {
    const { server, cookie, dir } = await serverWith()
    await upload(server, cookie, "a.txt", "alpha")
    const chatDir = join(dir, "chats", SESSION)
    const moved = join(dir, "moved-away")
    await rename(chatDir, moved)
    await symlink(moved, chatDir)

    expect(await deleteChatFiles(dir, SESSION)).toBe(false)
    await expect(lstat(join(moved, "files", "a.txt"))).resolves.toBeDefined()
  })
})
