import { lstat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatFileInfo } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const dirs: string[] = []
const SESSION = "ses_sniff"

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "openchat-sniff-"))
  dirs.push(dir)
  const server = makeServer({ env: { WORKSPACE_DIR: dir } })
  return { server, cookie: await login(server), dir }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function upload(
  server: TestServer,
  cookie: string,
  name: string,
  body: string | Buffer,
): Promise<Response> {
  return await server.app.request(
    `/api/sessions/${SESSION}/files?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: typeof body === "string" ? body : new Uint8Array(body),
    },
  )
}

const cases: Array<[string, string, string, string]> = [
  ["text", "plain notes", "notes.txt", "text/plain; charset=utf-8"],
  ["markdown", "# Heading", "notes.md", "text/plain; charset=utf-8"],
  ["png", "\x89PNG\r\n\x1a\npayload", "pic.png", "image/png"],
  ["jpeg", "\xff\xd8\xff\xe0payload", "pic.jpeg", "image/jpeg"],
  ["gif", "GIF89apayload", "pic.gif", "image/gif"],
  ["webp", "RIFF\x00\x00\x00\x00WEBPpayload", "pic.webp", "image/webp"],
  ["pdf", "%PDF-1.7\npayload", "report.pdf", "application/pdf"],
  [
    "docx",
    "PK\x03\x04word/document.xmlpayload",
    "report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "xlsx",
    "PK\x03\x04xl/workbook.xmlpayload",
    "sheet.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    "pptx",
    "PK\x03\x04ppt/presentation.xmlpayload",
    "deck.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["zip", "PK\x03\x04entries", "bundle.zip", "application/zip"],
]

describe("upload sniffing: accepted", () => {
  it.each(cases)("accepts %s with the sniffed MIME", async (_label, body, name, mime) => {
    const { server, cookie } = await fixture()
    const response = await upload(server, cookie, name, Buffer.from(body, "latin1"))
    expect(response.status).toBe(201)
    const file = await json<ChatFileInfo>(response)
    expect(file.mime).toBe(mime)
    expect(file.origin).toBe("upload")

    const download = await server.app.request(`/api/sessions/${SESSION}/files/${name}`, {
      headers: { cookie },
    })
    expect(download.headers.get("content-type")).toBe(mime)
  })
})

describe("upload sniffing: rejected", () => {
  const rejected: Array<[string, string, string | Buffer]> = [
    ["html renamed to text", "evil.txt", "<!DOCTYPE html><html><body>x</body></html>"],
    ["svg renamed to text", "evil.txt", "<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'/>"],
    ["pdf renamed to png", "fake.png", "%PDF-1.7\npayload"],
    ["text renamed to pdf", "fake.pdf", "this is just text"],
    ["html extension", "page.html", "<html><body>x</body></html>"],
    ["svg extension", "image.svg", "plain text"],
    ["empty body", "empty.txt", Buffer.alloc(0)],
    ["nul in text", "nul.txt", "hello\x00world"],
  ]

  it.each(rejected)("refuses %s with 415 unsupported_media_type", async (_label, name, body) => {
    const { server, cookie, dir } = await fixture()
    const response = await upload(server, cookie, name, body)
    expect(response.status).toBe(415)
    expect(await json(response)).toMatchObject({ error: { code: "unsupported_media_type" } })
    await expect(lstat(join(dir, "chats"))).rejects.toThrow()
  })

  it("checks the name before the bytes, so a bad name keeps its 400", async () => {
    const { server, cookie } = await fixture()
    const response = await upload(server, cookie, "..", "payload")
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "invalid_name" } })
  })

  it("still answers 413 before sniffing an oversized body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openchat-sniff-limit-"))
    dirs.push(dir)
    const server = makeServer({ env: { WORKSPACE_DIR: dir, WORKSPACE_MAX_FILE_BYTES: "4" } })
    const cookie = await login(server)
    const response = await upload(server, cookie, "five.txt", "12345")
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: "payload_too_large" } })
  })
})
