import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { STT_MODEL_FILES, STT_MODEL_ID } from "@openchat/contracts"
import type { DictationInfo } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"
import { localModelAvailable, serveModelFile, sttModelDir } from "../src/models"

const created: string[] = []
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

function modelDir(files: readonly string[] = STT_MODEL_FILES.map((file) => file.path)): string {
  const root = mkdtempSync(join(tmpdir(), "openchat-models-"))
  created.push(root)
  for (const file of files) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `fixture:${file}`)
  }
  return root
}

async function capability(env: Record<string, string | undefined>): Promise<DictationInfo> {
  const server = makeServer({ env })
  const cookie = await login(server)
  const body = await json<{ dictation: DictationInfo }>(
    await server.app.request("/api/info", { headers: { cookie } }),
  )
  return body.dictation
}

describe("local model capability", () => {
  it("reports the local path only when the complete pinned set exists", async () => {
    const dir = modelDir()
    expect(await localModelAvailable(dir)).toBe(true)
    expect(await capability({ STT_MODEL_DIR: dir })).toMatchObject({
      local: { available: true, model: STT_MODEL_ID },
      server: { available: false },
    })
  })

  it("keeps the microphone when only the server path is configured", async () => {
    const info = await capability({ STT_URL: "http://127.0.0.1:8899" })
    expect(info).toMatchObject({
      enabled: true,
      local: { available: false },
      server: { available: true },
    })
  })

  it("reports both paths when both are present", async () => {
    const dir = modelDir()
    const info = await capability({
      STT_MODEL_DIR: dir,
      STT_URL: "http://127.0.0.1:8899",
    })
    expect(info).toMatchObject({
      enabled: true,
      local: { available: true },
      server: { available: true },
    })
  })

  it("does not advertise an incomplete model set", async () => {
    const files = STT_MODEL_FILES.map((file) => file.path).filter((path) => !path.endsWith("config.json"))
    const info = await capability({ STT_MODEL_DIR: modelDir(files) })
    expect(info.enabled).toBe(false)
    expect(info.local?.available).toBe(false)
  })

  it("defaults STT_MODEL_DIR to the project public directory", () => {
    expect(sttModelDir({}).endsWith("apps/web/public/models")).toBe(true)
  })
})

describe("/models/ static route", () => {
  it("serves a pinned file same-origin with immutable, nosniff headers", async () => {
    const dir = modelDir()
    const response = await serveModelFile(
      dir,
      new Request("http://localhost:8787/models/whisper-base/config.json"),
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response?.headers.get("content-type")).toBe("application/json")
    expect(await response?.text()).toBe("fixture:whisper-base/config.json")
  })

  it("answers 404 for a missing pinned file", async () => {
    const response = await serveModelFile(
      modelDir(),
      new Request("http://localhost:8787/models/whisper-base/missing.onnx"),
    )
    expect(response?.status).toBe(404)
  })

  it("rejects traversal outside the model directory", async () => {
    const dir = modelDir()
    const outside = join(dir, "..", "secret.json")
    writeFileSync(outside, "SHOULD-NOT-BE-SERVED")
    created.push(outside)

    const attempts = [
      "http://localhost:8787/models/../secret.json",
      "http://localhost:8787/models/%2e%2e/secret.json",
      "http://localhost:8787/models/whisper-base/../../secret.json",
      "http://localhost:8787/models/%00secret.json",
    ]
    for (const url of attempts) {
      const response = await serveModelFile(dir, new Request(url))
      expect([404, undefined]).toContain(response?.status)
      expect(response?.status).not.toBe(200)
      if (response) expect(await response.text()).not.toContain("SHOULD-NOT-BE-SERVED")
    }
  })

  it("is read-only and ignores non-model paths", async () => {
    const dir = modelDir()
    expect(
      await serveModelFile(
        dir,
        new Request("http://localhost:8787/models/whisper-base/config.json", { method: "POST" }),
      ),
    ).toBeUndefined()
    expect(await serveModelFile(dir, new Request("http://localhost:8787/api/info"))).toBeUndefined()
  })
})
