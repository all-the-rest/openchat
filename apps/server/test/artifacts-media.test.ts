import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ArtifactResponse, ArtifactWriteReceipt } from "@openchat/contracts"
import { ARTIFACT_MEDIA_FILE } from "@openchat/contracts/artifacts/id"
import { loadArtifactEnv } from "../src/env-artifacts"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const HOST = "http://artifacts.example:4100"
const KEY = "test-artifact-signing-key-0123456789"
const TOKEN = "test-internal-token-0123456789abcdef"
/** A complete, minimal PNG: magic bytes plus an IHDR-shaped body. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082",
  "hex",
)

const dirs: string[] = []
async function artifactDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-artifacts-media-"))
  dirs.push(dir)
  return dir
}
function env(dir: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ARTIFACT_HOST_URL: HOST,
    ARTIFACT_SIGNING_KEY: KEY,
    ARTIFACT_INTERNAL_TOKEN: TOKEN,
    ARTIFACTS_DIR: dir,
    ...overrides,
  }
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function writePNG(server: TestServer, title = "Chart") {
  return server.app.request("/internal/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ title, data: PNG.toString("base64") }),
  })
}

describe("binary artifact store through the internal route", () => {
  it("stores the exact bytes under a content-addressed id with a sniffed MIME", async () => {
    const dir = await artifactDir()
    const server = makeServer({ env: env(dir) })
    const response = await writePNG(server)
    expect(response.status).toBe(201)
    const receipt = await json<ArtifactWriteReceipt>(response)
    expect(receipt).toEqual({
      artifactID: createHash("sha256").update(PNG).digest("hex"),
      title: "Chart",
      bytes: PNG.byteLength,
    })

    const id = receipt.artifactID
    expect(await readFile(join(dir, id, ARTIFACT_MEDIA_FILE))).toEqual(PNG)
    const stored = JSON.parse(await readFile(join(dir, id, "meta.json"), "utf8")) as {
      mime: string
    }
    expect(stored.mime).toBe("image/png")

    const cookie = await login(server)
    const list = await json<ArtifactResponse[]>(
      await server.app.request("/api/artifacts", { headers: { cookie } }),
    )
    expect(list[0]).toMatchObject({ id, mime: "image/png", bytes: PNG.byteLength })
    expect(list[0]?.url).toMatch(/\/a\/[0-9a-f]{64}\?exp=\d+&sig=/)
  })

  it("dedupes identical bytes and keeps the first title", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    expect((await writePNG(server, "First")).status).toBe(201)
    const second = await json<ArtifactWriteReceipt>(await writePNG(server, "Second"))
    expect(second.title).toBe("First")
    const cookie = await login(server)
    const list = await json<ArtifactResponse[]>(
      await server.app.request("/api/artifacts", { headers: { cookie } }),
    )
    expect(list).toHaveLength(1)
  })

  it("refuses HTML smuggled through the binary field", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await server.app.request("/internal/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        title: "Smuggled",
        data: Buffer.from("<!doctype html><html><body>hi</body></html>").toString("base64"),
      }),
    })
    expect(response.status).toBe(400)
    expect((await json<{ error: { message: string } }>(response)).error.message).toBe(
      "HTML must be written with the html field",
    )
  })

  it.each([
    ["non-base64 text", "not base64!"],
    ["url-safe base64", "-_".repeat(8)],
    ["non-canonical padding", Buffer.from(PNG).toString("base64").slice(0, -2) + "=="],
    ["empty", ""],
  ])("refuses %s binary data", async (_label, data) => {
    const server = makeServer({ env: env(await artifactDir()) })
    const response = await server.app.request("/internal/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ title: "Bad", data }),
    })
    expect(response.status).toBe(400)
  })

  it("refuses a body with both byte fields or neither", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    for (const body of [{ title: "Both", html: "<html></html>", data: PNG.toString("base64") }, { title: "Neither" }]) {
      const response = await server.app.request("/internal/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
  })
})

describe("binary download through the app origin", () => {
  it("keeps the sniffed type even when the client asks for HTML", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const receipt = await json<ArtifactWriteReceipt>(await writePNG(server))
    const cookie = await login(server)
    const response = await server.app.request(`/api/artifacts/${receipt.artifactID}/download`, {
      headers: { cookie, accept: "text/html" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-disposition")).toContain(".png")
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })
})

describe("production refusal", () => {
  it("refuses a configured host with no signing key", () => {
    expect(() =>
      loadArtifactEnv(
        { hostUrl: "https://artifacts.example.com" },
        { production: true, warn: () => {} },
      ),
    ).toThrow(/ARTIFACT_SIGNING_KEY must be set when ARTIFACT_HOST_URL is configured/)
  })

  it("accepts an explicitly configured key", () => {
    expect(
      loadArtifactEnv(
        {
          hostUrl: "https://artifacts.example.com",
          signingKey: KEY,
          internalToken: TOKEN,
        },
        { production: true, warn: () => {} },
      ).signingKey,
    ).toBe(KEY)
  })
})
