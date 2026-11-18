import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SttManifestFile } from "@openchat/contracts"
import { FetchFailure, fetchModel } from "../../../scripts/stt-fetch"

const created: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections()
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function fixtureFile(path: string, content: string): SttManifestFile {
  const bytes = new TextEncoder().encode(content)
  return { path, sha256: digest(bytes), bytes: bytes.byteLength, origin: "model" }
}

async function serveFiles(files: Record<string, string>): Promise<string> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "").replace(/^\//, ""))
    const content = files[path]
    if (content === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    const bytes = new TextEncoder().encode(content)
    const range = request.headers.range
    if (range) {
      const match = /^bytes=(\d+)-$/.exec(range)
      if (!match) {
        response.writeHead(416)
        response.end()
        return
      }
      const start = Number(match[1])
      response.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
        "content-length": String(bytes.length - start),
      })
      response.end(bytes.subarray(start))
      return
    }
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no fixture port")
  return `http://127.0.0.1:${address.port}`
}

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "openchat-stt-fetch-"))
  created.push(root)
  return root
}

describe("stt:fetch provisioning", () => {
  it("downloads pinned files and verifies size and SHA-256", async () => {
    const contents: Record<string, string> = {
      "whisper-base/config.json": "config-bytes",
      "whisper-base/tokenizer.json": "tokenizer-bytes",
    }
    const files = Object.entries(contents).map(([path, content]) => fixtureFile(path, content))
    const base = await serveFiles(contents)
    const dir = tempDir()
    await fetchModel({
      destDir: dir,
      files,
      urlFor: (file) => `${base}/${file.path}`,
      log: () => undefined,
    })
    for (const file of files) {
      expect(existsSync(join(dir, file.path))).toBe(true)
      expect(readFileSync(join(dir, file.path), "utf8")).toBe(contents[file.path])
      expect(existsSync(join(dir, `${file.path}.part`))).toBe(false)
    }
  })

  it("resumes an interrupted download from its .part file", async () => {
    const file = fixtureFile("whisper-base/tokenizer.json", "resume-me-please")
    const base = await serveFiles({ [file.path]: "resume-me-please" })
    const dir = tempDir()
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(`${target}.part`, new TextEncoder().encode("resume"))
    await fetchModel({ destDir: dir, files: [file], urlFor: () => `${base}/${file.path}` })
    expect(readFileSync(target, "utf8")).toBe("resume-me-please")
  })

  it("refuses a checksum mismatch with an actionable message", async () => {
    const expected = fixtureFile("whisper-base/config.json", "expected")
    const base = await serveFiles({ [expected.path]: "corrupted-bytes" })
    const dir = tempDir()
    await expect(
      fetchModel({ destDir: dir, files: [expected], urlFor: () => `${base}/${expected.path}` }),
    ).rejects.toThrow(FetchFailure)
    await expect(
      fetchModel({ destDir: dir, files: [expected], urlFor: () => `${base}/${expected.path}` }),
    ).rejects.toThrow(/checksum mismatch.*expected .* got /)
    expect(existsSync(join(dir, expected.path))).toBe(false)
  })

  it("does not re-download an already verified file", async () => {
    const file = fixtureFile("whisper-base/config.json", "already-here")
    const dir = tempDir()
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, "already-here")
    let requested = 0
    await fetchModel({
      destDir: dir,
      files: [file],
      urlFor: () => {
        requested += 1
        return "http://127.0.0.1:1/unused"
      },
    })
    expect(requested).toBe(0)
  })
})
