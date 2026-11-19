import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatFileInfo } from "@openchat/contracts"
import { ChatFilesStore } from "../src/chat-files-store"
import { json, login, makeServer } from "./helpers"

const dirs: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-generated-pdf-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const SESSION = "ses_generated_pdf"

function filesPath(sessionID = SESSION): string {
  return `/api/sessions/${sessionID}/files`
}

/**
 * A structurally valid minimal PDF: Catalog/Pages/Page/Font/content objects,
 * an xref table whose 10-digit offsets point at real object headers, a
 * matching startxref, trailer and %%EOF. Not a magic-byte-only stub.
 */
const PDF = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDQgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA3MiA3MjAgVGQgKE9wZW5DaGF0IFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwNAolJUVPRgo=",
  "base64",
)

/** Proves the bytes have a real PDF structure, not just the magic prefix. */
function assertRealPdf(bytes: Buffer): void {
  const text = bytes.toString("latin1")

  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
  expect(text).toContain("%%EOF")

  const startxref = /startxref\s+(\d+)/.exec(text)
  expect(startxref).not.toBeNull()
  if (!startxref) throw new Error("PDF has no startxref")
  const xrefAt = Number(startxref[1])
  expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref")

  expect(text).toContain("/Type /Catalog")
  expect(text).toContain("/Type /Pages")
  expect(text).toContain("/Type /Page")
  expect(text).toMatch(/\/Size \d+/)
  expect(text).toMatch(/\/Root \d+ \d+ R/)

  // Every in-use xref entry must point at a real "N G obj" header at that byte.
  const entry = /^(\d{10}) 00000 n $/gm
  let match: RegExpExecArray | null
  let checked = 0
  while ((match = entry.exec(text)) !== null) {
    expect(text.slice(Number(match[1]))).toMatch(/^\d+ \d+ obj/)
    checked += 1
  }
  // The fixture has five in-use objects (1..5) plus object 0 free; losing an
  // xref row must fail this check, not silently pass with fewer entries.
  expect(checked).toBe(5)
}

describe("generated PDF download", () => {
  it("serves an agent-written PDF byte-for-byte through the real download route", async () => {
    const dir = await workspace()
    const server = makeServer({ env: { WORKSPACE_DIR: dir } })
    const cookie = await login(server)
    const store = new ChatFilesStore({
      workspaceDir: dir,
      quotaPerChatBytes: server.config.WORKSPACE_QUOTA_PER_CHAT_BYTES,
      quotaTotalBytes: server.config.WORKSPACE_QUOTA_TOTAL_BYTES,
      maxFileBytes: server.config.WORKSPACE_MAX_FILE_BYTES,
    })

    const written = await store.write(SESSION, {
      name: "report.pdf",
      bytes: PDF,
      origin: "agent",
      mime: "application/pdf",
    })
    expect(written.ok).toBe(true)
    if (!written.ok) throw new Error("agent PDF write failed")
    expect(written.file.origin).toBe("agent")
    expect(written.file.sha256).toBe(createHash("sha256").update(PDF).digest("hex"))

    const download = await server.app.request(`${filesPath()}/report.pdf`, {
      headers: { cookie },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get("content-type")).toBe("application/pdf")
    expect(download.headers.get("content-disposition")).toContain(
      'attachment; filename="report.pdf"',
    )
    expect(download.headers.get("x-content-type-options")).toBe("nosniff")
    const downloaded = Buffer.from(await download.arrayBuffer())
    expect(downloaded).toEqual(PDF)
    assertRealPdf(downloaded)
  })

  it("accepts the same valid PDF through the upload route and serves identical bytes", async () => {
    const dir = await workspace()
    const server = makeServer({ env: { WORKSPACE_DIR: dir } })
    const cookie = await login(server)

    const created = await server.app.request(`${filesPath()}?name=report.pdf`, {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(PDF),
    })
    expect(created.status).toBe(201)
    expect(await json<ChatFileInfo>(created)).toMatchObject({ mime: "application/pdf" })

    const download = await server.app.request(`${filesPath()}/report.pdf`, {
      headers: { cookie },
    })
    expect(download.status).toBe(200)
    const downloaded = Buffer.from(await download.arrayBuffer())
    expect(downloaded).toEqual(PDF)
    assertRealPdf(downloaded)
  })
})
