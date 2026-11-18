import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ARTIFACT_MAX_BYTES, ARTIFACT_TITLE_MAX } from "@openchat/contracts"
import { ArtifactStore, cleanTitle } from "../src/artifacts-store"

const HTML = "<!doctype html><html><body>hi</body></html>"
const cleanup: Array<() => Promise<void>> = []

async function tempStore(now?: () => number): Promise<{ store: ArtifactStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openchat-artifacts-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return { store: new ArtifactStore({ dir, now }), dir }
}

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

function digest(html: string): string {
  return createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex")
}

describe("artifact validation", () => {
  it.each([
    ["missing title", {}, "title must be a string"],
    ["numeric title", { title: 1, html: HTML }, "title must be a string"],
    ["missing html", { title: "x" }, "html must be a string"],
    ["blank html", { title: "x", html: "" }, "html must not be empty"],
    ["whitespace html", { title: "x", html: "   \n\t " }, "html must not be empty"],
    [
      "not a document",
      { title: "x", html: "<div>hi</div>" },
      "html must start with <!doctype html or <html",
    ],
    [
      "doctype without html",
      { title: "x", html: "<!doctype xml><?x?>" },
      "html must start with <!doctype html or <html",
    ],
    [
      "too large",
      { title: "x", html: `<html>${"a".repeat(ARTIFACT_MAX_BYTES)}</html>` },
      `html must not exceed ${ARTIFACT_MAX_BYTES} bytes`,
    ],
  ])("rejects %s", async (_label, draft, reason) => {
    const { store, dir } = await tempStore()
    const result = await store.create(draft as { title: unknown; html: unknown })
    expect(result).toEqual({ ok: false, reason })
    await expect(readdir(dir)).resolves.toEqual([])
  })

  it.each([
    ["doctype", "<!doctype html><html></html>"],
    ["doctype uppercase", "<!DOCTYPE HTML><html></html>"],
    ["leading whitespace", "\n  <html><body></body></html>"],
    ["byte-order mark", "\uFEFF<html></html>"],
  ])("accepts a document starting with %s", async (_label, html) => {
    const { store } = await tempStore()
    const result = await store.create({ title: "x", html })
    expect(result.ok).toBe(true)
  })

  it("accepts a document of exactly the byte cap", async () => {
    const { store } = await tempStore()
    const prefix = "<html>"
    const html = `${prefix}${"a".repeat(ARTIFACT_MAX_BYTES - prefix.length - "</html>".length)}</html>`
    expect(Buffer.byteLength(html)).toBe(ARTIFACT_MAX_BYTES)
    expect((await store.create({ title: "x", html })).ok).toBe(true)
  })
})

describe("title sanitisation", () => {
  it("trims and keeps plain text", () => {
    expect(cleanTitle("  Quarterly report  ")).toBe("Quarterly report")
  })

  it("replaces control characters with a space", () => {
    expect(cleanTitle("a\u0000b\nc\u007fd")).toBe("a b c d")
  })

  it("falls back to Untitled when blank", () => {
    expect(cleanTitle("")).toBe("Untitled")
    expect(cleanTitle("  \u0000 \t ")).toBe("Untitled")
  })

  it("caps at the title maximum by code points", () => {
    const long = "🙂".repeat(ARTIFACT_TITLE_MAX + 10)
    const cleaned = cleanTitle(long)
    expect([...cleaned]).toHaveLength(ARTIFACT_TITLE_MAX)
    // No lone surrogate was produced by the cut.
    expect(cleaned).toBe("🙂".repeat(ARTIFACT_TITLE_MAX))
  })

  it("applies the sanitised title to the stored metadata", async () => {
    const { store } = await tempStore()
    const result = await store.create({ title: "  line\nbreak  ", html: HTML })
    expect(result.ok && result.artifact.title).toBe("line break")
  })
})

describe("artifact store", () => {
  it("stores the document and its metadata under the content hash", async () => {
    const { store, dir } = await tempStore(() => Date.UTC(2026, 0, 2, 3, 4, 5))
    const result = await store.create({ title: "Report", html: HTML })
    const id = digest(HTML)
    expect(result).toEqual({
      ok: true,
      artifact: {
        id,
        title: "Report",
        bytes: Buffer.byteLength(HTML),
        createdAt: "2026-01-02T03:04:05.000Z",
      },
    })
    await expect(readFile(join(dir, id, "index.html"), "utf8")).resolves.toBe(HTML)
    const meta: unknown = JSON.parse(await readFile(join(dir, id, "meta.json"), "utf8"))
    expect(meta).toEqual({
      title: "Report",
      bytes: Buffer.byteLength(HTML),
      createdAt: "2026-01-02T03:04:05.000Z",
    })
    // No temporary file survived the atomic write.
    await expect(readdir(join(dir, id))).resolves.toEqual(["index.html", "meta.json"])
  })

  it("shares one directory for identical documents and keeps the first title", async () => {
    let now = Date.UTC(2026, 0, 1)
    const { store, dir } = await tempStore(() => now)
    const first = await store.create({ title: "First", html: HTML })
    now += 60_000
    const second = await store.create({ title: "Second", html: HTML })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.artifact.id).toBe(first.artifact.id)
    expect(second.artifact.title).toBe("First")
    expect(second.artifact.createdAt).toBe("2026-01-01T00:00:00.000Z")
    await expect(readdir(dir)).resolves.toEqual([first.artifact.id])
  })

  it("distinguishes documents that differ by one byte", async () => {
    const { store } = await tempStore()
    const first = await store.create({ title: "x", html: "<html>a</html>" })
    const second = await store.create({ title: "x", html: "<html>b</html>" })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.artifact.id).not.toBe(second.artifact.id)
  })

  it("returns null for unknown, unshaped and missing entries", async () => {
    const { store, dir } = await tempStore()
    expect(await store.get("b".repeat(64))).toBeNull()
    expect(await store.get("B".repeat(64))).toBeNull()
    expect(await store.get("../".repeat(22))).toBeNull()
    expect(await store.get("")).toBeNull()

    // A directory without readable metadata is not an artifact.
    const broken = join(dir, "c".repeat(64))
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, "meta.json"), "{not json")
    expect(await store.get("c".repeat(64))).toBeNull()
    await writeFile(join(broken, "meta.json"), JSON.stringify({ title: 1 }))
    expect(await store.get("c".repeat(64))).toBeNull()
  })

  it("lists newest first and ignores noise", async () => {
    let now = Date.UTC(2026, 0, 1)
    const { store, dir } = await tempStore(() => now)
    const ids: string[] = []
    for (const label of ["one", "two", "three"]) {
      now += 1_000
      const result = await store.create({ title: label, html: `<html>${label}</html>` })
      if (result.ok) ids.push(result.artifact.id)
    }
    await writeFile(join(dir, "notes.txt"), "ignore me")
    await mkdir(join(dir, "not-an-id"))

    const listed = await store.list()
    expect(listed.map((item) => item.title)).toEqual(["three", "two", "one"])
    expect(listed.map((item) => item.id)).toEqual([...ids].reverse())
  })

  it("caps the list at 100 and honours a smaller limit", async () => {
    const { store } = await tempStore()
    for (let index = 0; index < 105; index += 1) {
      await store.create({ title: `doc ${index}`, html: `<html>${index}</html>` })
    }
    expect(await store.list()).toHaveLength(100)
    expect(await store.list({ limit: 3 })).toHaveLength(3)
    expect(await store.list({ limit: 500 })).toHaveLength(100)
  })

  it("answers an empty list when the directory does not exist", async () => {
    const store = new ArtifactStore({ dir: join(tmpdir(), `openchat-missing-${Date.now()}`) })
    await expect(store.list()).resolves.toEqual([])
  })

  it("leaves only the two real files after a repeat write", async () => {
    const { store, dir } = await tempStore()
    const result = await store.create({ title: "x", html: HTML })
    if (!result.ok) throw new Error("create failed")
    await store.create({ title: "y", html: HTML })
    await expect(readdir(join(dir, result.artifact.id))).resolves.toEqual([
      "index.html",
      "meta.json",
    ])
  })
})
