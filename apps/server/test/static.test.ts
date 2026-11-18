import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serveStatic, webDistDir, WEB_DIST_ENV } from "../src/static"

const dist = mkdtempSync(join(tmpdir(), "openchat-static-"))
mkdirSync(join(dist, "assets"), { recursive: true })
mkdirSync(join(dist, "nested"), { recursive: true })
writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>")
writeFileSync(join(dist, "assets", "app-abc123.js"), "export const ready = true\n")
writeFileSync(join(dist, "assets", "app.js"), "export const app = true\n")
writeFileSync(join(dist, "assets", "app-abc123.css"), "body{margin:0}\n")
writeFileSync(join(dist, "favicon.svg"), "<svg></svg>")
writeFileSync(join(dist, "api"), "a build file must never shadow the API\n")
writeFileSync(join(dist, "nested", "index.html"), "<!doctype html><p>nested</p>")
writeFileSync(join(dist, "secret.txt"), "not reachable from outside")
writeFileSync(join(tmpdir(), "openchat-static-sibling.txt"), "sibling")

afterAll(() => {
  // The fixture lives in the OS temp directory; a leaked directory is harmless.
  expect(dist.startsWith(tmpdir())).toBe(true)
})

function get(path: string, method = "GET"): Promise<Response | undefined> {
  return serveStatic({ distDir: dist }, new Request(`http://127.0.0.1:8787${path}`, { method }))
}

describe("webDistDir", () => {
  it("is empty unless WEB_DIST_DIR names a directory", () => {
    expect(WEB_DIST_ENV).toBe("WEB_DIST_DIR")
    expect(webDistDir({})).toBe("")
    expect(webDistDir({ WEB_DIST_DIR: "   " })).toBe("")
  })

  it("resolves a relative value against the working directory", () => {
    expect(webDistDir({ WEB_DIST_DIR: "/app/web" })).toBe("/app/web")
    expect(webDistDir({ WEB_DIST_DIR: "apps/web/dist" })).toBe(join(process.cwd(), "apps/web/dist"))
  })
})

describe("serveStatic", () => {
  it("serves the SPA shell at the origin root without letting it be cached", async () => {
    const response = await get("/")
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await response?.text()).toContain("id=root")
  })

  it("falls back to the shell for a client-side route", async () => {
    const response = await get("/workspace/ses_123")
    expect(response?.status).toBe(200)
    expect(await response?.text()).toContain("id=root")
  })

  it("serves a content-hashed asset immutably", async () => {
    const response = await get("/assets/app-abc123.js")
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await response?.text()).toBe("export const ready = true\n")

    const css = await get("/assets/app-abc123.css")
    expect(css?.headers.get("content-type")).toBe("text/css; charset=utf-8")
  })

  it("serves a top-level file with a short-lived shell policy", async () => {
    const response = await get("/favicon.svg")
    expect(response?.headers.get("content-type")).toBe("image/svg+xml")
    expect(response?.headers.get("cache-control")).toBe("no-store")
  })

  it("does not answer a missing asset with the shell", async () => {
    expect(await get("/assets/missing.js")).toBeUndefined()
    expect(await get("/robots.txt")).toBeUndefined()
  })

  it("never resolves /api, /healthz or a non-GET method against the disk", async () => {
    expect(await get("/api/info")).toBeUndefined()
    expect(await get("/healthz")).toBeUndefined()
    expect(await get("/", "POST")).toBeUndefined()
    expect(await get("/assets/app-abc123.js", "DELETE")).toBeUndefined()
  })

  it("keeps a reserved route out of the shell whatever the spelling", async () => {
    // `dist/api` exists in the fixture: a file of that name must not shadow the
    // API even when URL spelling differs from the canonical path.
    const reserved = [
      "/api",
      "/api/info",
      "//api/info",
      "/API/info",
      "/Api",
      "/HealthZ",
      "/healthz/",
    ]
    for (const path of reserved) {
      expect(await get(path), `${path} must fall through to the API`).toBeUndefined()
    }
  })

  it("still serves assets and SPA routes once the first segment is not reserved", async () => {
    const asset = await get("/assets/app.js")
    expect(asset?.status).toBe(200)
    expect(asset?.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await asset?.text()).toContain("export const app = true")

    for (const path of ["/workspace/ses_123", "/settings/profile"]) {
      const response = await get(path)
      expect(response?.status, `${path} is a client route`).toBe(200)
      expect(await response?.text()).toContain("id=root")
    }
  })

  it("answers HEAD with headers and no body", async () => {
    const response = await get("/assets/app-abc123.js", "HEAD")
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-length")).toBe(String("export const ready = true\n".length))
    expect(await response?.text()).toBe("")
  })

  it("refuses a path that climbs out of the build directory", async () => {
    expect(await get("/../openchat-static-sibling.txt")).toBeUndefined()
    expect(await get("/%2e%2e/openchat-static-sibling.txt")).toBeUndefined()
    expect(await get("/assets/../../openchat-static-sibling.txt")).toBeUndefined()
    // Encoded separators: `new URL` leaves `%2f` alone, so only the decoded
    // containment check can refuse these.
    expect(await get("/%2e%2e%2fopenchat-static-sibling.txt")).toBeUndefined()
    expect(await get("/assets%2f..%2f..%2fopenchat-static-sibling.txt")).toBeUndefined()
    expect(await get("/%00/secret.txt")).toBeUndefined()
    // Normalised back into the build directory: the shell, never a listing.
    const self = await get("/../openchat-static")
    expect(await self?.text()).toContain("id=root")
  })

  it("does not treat a directory as a file", async () => {
    const response = await get("/assets")
    // `/assets` has no extension, so it is a client route, not a listing.
    expect(await response?.text()).toContain("id=root")
  })

  it("falls through when the build is missing", async () => {
    const missing = join(dist, "does-not-exist")
    expect(
      await serveStatic({ distDir: missing }, new Request("http://127.0.0.1:8787/")),
    ).toBeUndefined()
  })

  it("does not answer a malformed percent escape", async () => {
    expect(await get("/%E0%A4%A")).toBeUndefined()
  })
})
