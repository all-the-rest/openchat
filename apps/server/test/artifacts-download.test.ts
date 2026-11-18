import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ArtifactResponse } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const HOST = "http://artifacts.example:4100"
const KEY = "test-artifact-signing-key-0123456789"
const HTML = "<!doctype html><html><body>hello</body></html>"
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)

const dirs: string[] = []

async function artifactDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-artifacts-"))
  dirs.push(dir)
  return dir
}

function env(dir: string) {
  return {
    ARTIFACT_HOST_URL: HOST,
    ARTIFACT_SIGNING_KEY: KEY,
    ARTIFACTS_DIR: dir,
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function post(server: TestServer, cookie: string, body: unknown): Promise<Response> {
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("artifact download", () => {
  it("returns the stored bytes verbatim without a host URL in the body", async () => {
    const server = makeServer({ env: env(await artifactDir()), artifactsNow: () => NOW })
    const cookie = await login(server)
    const created = await json<ArtifactResponse>(
      await post(server, cookie, { title: "Report", html: HTML }),
    )

    const response = await server.app.request(`/api/artifacts/${created.id}/download`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="artifact-${created.id}.html"`,
    )
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")

    const body = await response.text()
    expect(body).toBe(HTML)
    expect(body).not.toContain(created.url)
    expect(body).not.toContain(created.id)
  })

  it("answers 404 for unknown and unshaped ids without echoing them", async () => {
    const server = makeServer({ env: env(await artifactDir()) })
    const cookie = await login(server)
    for (const id of ["b".repeat(64), "B".repeat(64), "abc", `${"c".repeat(63)}z`, "null"]) {
      const response = await server.app.request(`/api/artifacts/${id}/download`, {
        headers: { cookie },
      })
      expect(response.status).toBe(404)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual({
        error: { code: "artifacts_unknown", message: "Unknown artifact" },
      })
      expect(text).not.toContain(id)
    }
  })

  it("answers 503 when the surface is not configured", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request(`/api/artifacts/${"a".repeat(64)}/download`, {
      headers: { cookie },
    })
    expect(response.status).toBe(503)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe(
      "artifacts_unavailable",
    )
  })
})
