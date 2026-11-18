import { readdir, rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { ArtifactSigner } from "@openchat/contracts/artifacts/sign"
import { CSP_POLICIES, SANDBOX_POLICY, documentPolicy } from "../src/app"
import { nodeHeaders } from "../src/http"
import { ArtifactReader } from "../src/store"
import {
  FRAME_ANCESTORS,
  KEY,
  artifactFixture,
  makeConfig,
  nowSeconds,
  rawHeaderValues,
  rawRequest,
  signedPath,
  startHost,
} from "./helpers"

const HTML = "<!doctype html><html><body><h1>Grüße</h1></body></html>"
const OTHER_KEY = "another-signing-key-0123456789abcdef"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const task of cleanups.splice(0).reverse()) await task()
})

function track<T extends { close(): Promise<void> }>(value: T): T {
  cleanups.push(() => value.close())
  return value
}

async function hostWithFixture(html = HTML, overrides: Record<string, string | undefined> = {}) {
  const fixture = await artifactFixture(html)
  cleanups.push(() => rm(fixture.dir, { recursive: true, force: true }))
  const host = track(await startHost({ ARTIFACTS_DIR: fixture.dir, ...overrides }))
  return { host, fixture }
}

function url(id: string, exp: string | number, sig: string): string {
  return `/a/${id}?exp=${exp}&sig=${sig}`
}

function signature(id: string, exp: number, key = KEY): string {
  return new ArtifactSigner({ key }).sign(id, exp)
}

describe("document response", () => {
  it("serves the stored bytes with every sandbox header", async () => {
    const { host, fixture } = await hostWithFixture()
    const raw = await rawRequest(host.origin, signedPath(fixture.id))
    expect(raw.status).toBe(200)
    expect(raw.body).toBe(HTML)

    expect(raw.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(raw.headers["x-content-type-options"]).toBe("nosniff")
    expect(raw.headers["referrer-policy"]).toBe("no-referrer")
    expect(raw.headers["cache-control"]).toBe("no-store")
    expect(raw.headers.etag).toBe(`"sha256:${fixture.id}"`)

    // Two physical header lines: the document policy and the sandbox policy.
    expect(rawHeaderValues(raw.rawHeaders, "content-security-policy")).toEqual([
      documentPolicy(FRAME_ANCESTORS),
      SANDBOX_POLICY,
    ])
  })

  it("sends the documented document policy verbatim", () => {
    expect(documentPolicy("https://chat.example.com")).toBe(
      [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "media-src data: blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors https://chat.example.com",
      ].join("; "),
    )
    expect(SANDBOX_POLICY).toBe("sandbox allow-scripts")
  })

  it("never sets a cookie or a CORS header", async () => {
    const { host, fixture } = await hostWithFixture()
    const paths = [signedPath(fixture.id), "/healthz", `/a/${fixture.id}`, "/"]
    for (const path of paths) {
      const raw = await rawRequest(host.origin, path)
      expect(raw.headers["set-cookie"]).toBeUndefined()
      expect(raw.headers["access-control-allow-origin"]).toBeUndefined()
      expect(raw.headers["access-control-allow-credentials"]).toBeUndefined()
    }
  })

  it("refuses every unshaped or invalid signature with 403", async () => {
    const { host, fixture } = await hostWithFixture()
    const exp = nowSeconds() + 300
    const expired = nowSeconds() - 1
    const farFuture = nowSeconds() + 900 + 61
    const cases = [
      `/a/${fixture.id}`,
      url(fixture.id, exp, ""),
      url(fixture.id, exp, "A".repeat(43)),
      url(fixture.id, "1e9", signature(fixture.id, 1_000_000_000)),
      url(fixture.id, exp, `${signature(fixture.id, exp)}=`),
      url(fixture.id, expired, signature(fixture.id, expired)),
      url(fixture.id, farFuture, signature(fixture.id, farFuture)),
      url(fixture.id, exp, signature(fixture.id, exp, OTHER_KEY)),
      url(fixture.id.toUpperCase(), exp, signature(fixture.id.toUpperCase(), exp)),
    ]
    for (const path of cases) {
      const raw = await rawRequest(host.origin, path)
      expect(raw.status).toBe(403)
      expect(raw.body).not.toContain("Grüße")
      expect(JSON.parse(raw.body)).toEqual({
        error: { code: "artifact_forbidden", message: "artifact_forbidden" },
      })
      // A refusal must not look like a document: no ETag, no policy.
      expect(raw.headers.etag).toBeUndefined()
      expect(rawHeaderValues(raw.rawHeaders, "content-security-policy")).toEqual([])
    }
  })

  it("validates the signature before touching the filesystem", async () => {
    const missing = track(await startHost({ ARTIFACTS_DIR: "/nonexistent/openchat-artifacts" }))
    // A bad signature over a directory that does not exist is still a 403; a
    // 404 here would prove the file was probed first.
    const unsigned = await rawRequest(missing.origin, "/a/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd?exp=1&sig=bad")
    expect(unsigned.status).toBe(403)
    const valid = await rawRequest(missing.origin, signedPath("d".repeat(64)))
    expect(valid.status).toBe(404)
  })

  it("serves byte-identical output for non-ASCII content", async () => {
    const { host, fixture } = await hostWithFixture("<html><body>äöü €</body></html>")
    const raw = await rawRequest(host.origin, signedPath(fixture.id))
    expect(Buffer.from(raw.body, "utf8")).toEqual(Buffer.from(fixture.html, "utf8"))
  })
})

describe("missing artifact", () => {
  it("answers 404 for a valid signature over an absent id", async () => {
    const { host } = await hostWithFixture()
    const raw = await rawRequest(host.origin, signedPath("e".repeat(64)))
    expect(raw.status).toBe(404)
    expect(JSON.parse(raw.body)).toEqual({
      error: { code: "artifact_not_found", message: "artifact_not_found" },
    })
    expect(raw.headers.etag).toBeUndefined()
  })

  it("answers 404 for an unknown path without redirecting", async () => {
    const { host } = await hostWithFixture()
    const raw = await rawRequest(host.origin, "/")
    expect(raw.status).toBe(404)
    expect(raw.headers.location).toBeUndefined()
    expect(JSON.parse(raw.body)).toEqual({
      error: { code: "not_found", message: "not_found" },
    })
  })
})

describe("health", () => {
  it("answers 200 with no artifact headers", async () => {
    const host = track(await startHost())
    const raw = await rawRequest(host.origin, "/healthz")
    expect(raw.status).toBe(200)
    expect(JSON.parse(raw.body)).toEqual({ status: "ok" })
    expect(raw.headers.etag).toBeUndefined()
    expect(raw.headers["cache-control"]).not.toBe("no-store")
    expect(rawHeaderValues(raw.rawHeaders, "content-security-policy")).toEqual([])
  })
})

describe("read-only store", () => {
  it("never writes into the artifact directory", async () => {
    const { host, fixture } = await hostWithFixture()
    const before = await readdir(fixture.dir, { recursive: true })
    await rawRequest(host.origin, signedPath(fixture.id))
    await rawRequest(host.origin, signedPath("f".repeat(64)))
    const after = await readdir(fixture.dir, { recursive: true })
    expect(after.sort()).toEqual(before.sort())
  })

  it("rejects a traversing id before building a path", async () => {
    const reader = new ArtifactReader("/tmp/openchat-reader")
    await expect(reader.read("../".repeat(20))).resolves.toBeNull()
    await expect(reader.read("/etc/passwd")).resolves.toBeNull()
    await expect(reader.read(`${"a".repeat(63)}/`)).resolves.toBeNull()
  })
})

describe("node header map", () => {
  it("keeps both CSP policies as an array for two header lines", () => {
    const response = new Response("x", {
      headers: { "content-security-policy": "a, b" },
    })
    Object.defineProperty(response, CSP_POLICIES, {
      value: ["a", "b"],
      enumerable: false,
    })
    expect(nodeHeaders(response)["content-security-policy"]).toEqual(["a", "b"])
  })

  it("falls back to the joined value without the symbol", () => {
    const response = new Response("x", {
      headers: { "content-security-policy": "a, b" },
    })
    expect(nodeHeaders(response)["content-security-policy"]).toBe("a, b")
  })

  it("drops a Set-Cookie from any response", () => {
    const response = new Response("x", { headers: { "set-cookie": "a=b" } })
    expect(nodeHeaders(response)["set-cookie"]).toBeUndefined()
  })

  it("uses the configured frame ancestors", () => {
    const policy = documentPolicy(makeConfig().ARTIFACT_FRAME_ANCESTORS)
    expect(policy).toContain(`frame-ancestors ${FRAME_ANCESTORS}`)
    expect(policy).not.toContain(KEY)
  })
})
