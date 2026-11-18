import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  FRAME_ANCESTORS,
  KEY,
  artifactFixture,
  makeConfig,
  rawHeaderValues,
  rawRequest,
  signedPath,
  startHost,
} from "./helpers"
import { SANDBOX_POLICY, documentPolicy, mediaPolicy } from "../src/app"

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082",
  "hex",
)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const task of cleanups.splice(0).reverse()) await task()
})

function track<T extends { close(): Promise<void> }>(value: T): T {
  cleanups.push(() => value.close())
  return value
}

async function withFixture(bytes: Buffer, file = "artifact.bin") {
  const dir = await mkdtemp(join(tmpdir(), "openchat-artifact-security-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const id = createHash("sha256").update(bytes).digest("hex")
  await mkdir(join(dir, id), { recursive: true })
  await writeFile(join(dir, id, file), bytes)
  const host = track(await startHost({ ARTIFACTS_DIR: dir }))
  return { host, id }
}

describe("artifact origin credentials", () => {
  it("never sets a cookie, even when a request carries one", async () => {
    const fixture = await artifactFixture("<html><body>hello</body></html>")
    cleanups.push(() => rm(fixture.dir, { recursive: true, force: true }))
    const host = track(await startHost({ ARTIFACTS_DIR: fixture.dir }))
    const paths = [signedPath(fixture.id), "/healthz", "/", "/a/unknown"]
    for (const path of paths) {
      const plain = await rawRequest(host.origin, path)
      const withCookie = await rawRequest(host.origin, path, {
        headers: { cookie: "session=stolen; other=1" },
      })
      expect(plain.headers["set-cookie"]).toBeUndefined()
      expect(withCookie.headers["set-cookie"]).toBeUndefined()
      expect(withCookie.headers["content-type"]).toBe(plain.headers["content-type"])
      expect(withCookie.headers["cache-control"]).toBe(plain.headers["cache-control"])
      expect(withCookie.body).toBe(plain.body)
    }
  })
})

describe("sandboxed document policy on real responses", () => {
  it("forbids fetch, forms, remote sources and top navigation", async () => {
    const fixture = await artifactFixture("<html><body>hello</body></html>")
    cleanups.push(() => rm(fixture.dir, { recursive: true, force: true }))
    const host = track(await startHost({ ARTIFACTS_DIR: fixture.dir }))
    const raw = await rawRequest(host.origin, signedPath(fixture.id))

    const policies = rawHeaderValues(raw.rawHeaders, "content-security-policy")
    expect(policies).toEqual([documentPolicy(FRAME_ANCESTORS), SANDBOX_POLICY])
    const document = policies[0] ?? ""
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain("form-action 'none'")
    expect(document).toContain("base-uri 'none'")
    expect(document).toContain(`frame-ancestors ${FRAME_ANCESTORS}`)
    expect(document).not.toContain("'self'")
    // frame-ancestors names the chat origin; no other directive may name one.
    const sources = document.slice(0, document.indexOf("frame-ancestors"))
    expect(sources).not.toMatch(/https?:\/\//)
    // The second policy is the hedge if a future embed forgets the attribute.
    expect(policies[1]).toBe("sandbox allow-scripts")
    expect(policies[1]).not.toMatch(/allow-top-navigation|allow-same-origin|allow-popups/)
  })

  it("never redirects a request, including unknown and trailing-slash paths", async () => {
    const { host, id } = await withFixture(PNG)
    const paths = [
      signedPath(id),
      `/a/${id}/`,
      `/a/${id}/download`,
      "/a/unknown",
      "/healthz/",
      "/A/UPPER",
      "/",
    ]
    for (const path of paths) {
      const raw = await rawRequest(host.origin, path)
      expect(raw.status >= 300 && raw.status < 400).toBe(false)
      expect(raw.headers.location).toBeUndefined()
    }
  })
})

describe("binary artifacts cannot become documents", () => {
  it("ignores an accept: text/html request for image bytes", async () => {
    const { host, id } = await withFixture(PNG)
    const raw = await rawRequest(host.origin, signedPath(id), {
      headers: { accept: "text/html,application/xhtml+xml" },
    })
    expect(raw.status).toBe(200)
    expect(raw.headers["content-type"]).toBe("image/png")
    expect(raw.headers["x-content-type-options"]).toBe("nosniff")
    expect(raw.headers.etag).toBe(`"sha256:${id}"`)
    expect(raw.bytes.equals(PNG)).toBe(true)
    expect(raw.body).not.toContain("<html")
    const policies = rawHeaderValues(raw.rawHeaders, "content-security-policy")
    expect(policies).toEqual([mediaPolicy(FRAME_ANCESTORS)])
    expect(policies[0]).not.toContain("script-src")
  })

  it("serves a PDF as PDF bytes with the same framing policy", async () => {
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
    const { host, id } = await withFixture(pdf)
    const raw = await rawRequest(host.origin, signedPath(id), {
      headers: { accept: "text/html" },
    })
    expect(raw.status).toBe(200)
    expect(raw.headers["content-type"]).toBe("application/pdf")
    expect(rawHeaderValues(raw.rawHeaders, "content-security-policy")).toEqual([
      mediaPolicy(FRAME_ANCESTORS),
    ])
    expect(raw.bytes.equals(pdf)).toBe(true)
  })

  it("keeps a sandbox policy even when a caller requests HTML", async () => {
    const { host, id } = await withFixture(
      Buffer.from("<!doctype html><html><body>ok</body></html>"),
      "index.html",
    )
    const raw = await rawRequest(host.origin, signedPath(id), {
      headers: { accept: "application/pdf" },
    })
    expect(raw.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(rawHeaderValues(raw.rawHeaders, "content-security-policy")).toEqual([
      documentPolicy(FRAME_ANCESTORS),
      SANDBOX_POLICY,
    ])
  })
})

describe("signature gating before bytes", () => {
  it("gives the same 403 for an expired URL over binary and HTML artifacts", async () => {
    const { host, id } = await withFixture(PNG)
    const expired = Math.floor(Date.now() / 1000) - 1
    const raw = await rawRequest(host.origin, signedPath(id, { exp: expired }))
    expect(raw.status).toBe(403)
    expect(raw.headers["content-type"]).toContain("application/json")
    expect(rawHeaderValues(raw.rawHeaders, "content-security-policy")).toEqual([])
    expect(raw.headers.etag).toBeUndefined()
    expect(raw.headers["set-cookie"]).toBeUndefined()
  })

  it("uses the configured key for a binary artifact", async () => {
    const { host, id } = await withFixture(PNG)
    const raw = await rawRequest(host.origin, signedPath(id, { key: "wrong-key-0123456789abcdef" }))
    expect(raw.status).toBe(403)
    expect(makeConfig().ARTIFACT_SIGNING_KEY).toBe(KEY)
  })
})
