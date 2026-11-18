import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createArchiveRunner } from "../src/runner-archive"
import type { PythonRunner } from "../src/runner"
import { isToolSuccess, runDocumentTool } from "../src/tool"

/**
 * Real Python, real stdlib `zipfile`, real filesystem writes. The scripts need
 * no third-party package, so this suite runs wherever `python3` exists and
 * skips (like the document integration suite) where it does not.
 *
 *   fixtures: nested dirs, unicode, traversal, absolute, drive prefix, symlink,
 *   encrypted, duplicate name, depth, entry count, ratio bomb, oversized entry.
 */

const PYTHON = process.env.OPENCHAT_PYTHON?.trim() || process.env.PYTHON?.trim() || "python3"
const AVAILABLE = spawnSync(PYTHON, ["-c", "import zipfile, stat"], { encoding: "utf8" }).status === 0
const SCRIPT_DIR = fileURLToPath(new URL("../python", import.meta.url))

const FIXTURES = String.raw`
import json, os, random, stat, sys, zipfile

root = sys.argv[1]

def zip_of(name, mode=zipfile.ZIP_DEFLATED):
    return zipfile.ZipFile(os.path.join(root, name), "w", mode)

with zip_of("plain.zip") as zf:
    zf.writestr("notes/", "")
    zf.writestr("notes/readme.txt", "hello archive\n")
    zf.writestr("notes/unicode-ü-日本語.txt", "unicode\n")
    zf.writestr("data.csv", "a,b\n1,2\n")

with zip_of("traversal.zip") as zf:
    zf.writestr("../escape.txt", "x")

with zip_of("absolute.zip") as zf:
    zf.writestr("/etc/passwd", "x")

with zip_of("drive.zip") as zf:
    zf.writestr("C:/windows/x.txt", "x")

with zip_of("symlink.zip") as zf:
    info = zipfile.ZipInfo("link")
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    zf.writestr(info, "/etc/passwd")

with zip_of("duplicate.zip") as zf:
    zf.writestr("same.txt", "a")
    zf.writestr("same.txt", "b")

with zip_of("deep.zip") as zf:
    zf.writestr("a/b/c/d/e/f/g/h/i/j/k.txt", "x")

with zip_of("many.zip") as zf:
    for index in range(501):
        zf.writestr("f%03d.txt" % index, "x")

with zip_of("bomb.zip") as zf:
    zf.writestr("zeros.bin", b"\0" * (12 * 1024 * 1024))

random.seed(7)
with zip_of("big.zip", zipfile.ZIP_STORED) as zf:
    zf.writestr("big.bin", random.Random(7).randbytes(26 * 1024 * 1024))

with zip_of("encrypted.zip") as zf:
    zf.writestr("secret.txt", "x")
path = os.path.join(root, "encrypted.zip")
data = bytearray(open(path, "rb").read())
for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
    index = data.find(signature)
    while index != -1:
        flags = int.from_bytes(data[index + offset:index + offset + 2], "little") | 1
        data[index + offset:index + offset + 2] = flags.to_bytes(2, "little")
        index = data.find(signature, index + 1)
open(path, "wb").write(data)

open(os.path.join(root, "notzip.zip"), "wb").write(b"this is not a zip file")
print(json.dumps(sorted(os.listdir(root))))
`

interface Answer {
  status: number | null
  body: Record<string, unknown>
  stdout: string
  stderr: string
}

let fixtureDir = ""
let scratch = ""

function run(script: string, payload: unknown): Answer {
  const result = spawnSync(PYTHON, [join(SCRIPT_DIR, script)], {
    cwd: scratch,
    input: JSON.stringify(payload),
    encoding: "utf8",
  })
  return {
    status: result.status,
    body: JSON.parse(result.stdout) as Record<string, unknown>,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function codeOf(answer: Answer): unknown {
  return answer.body.code
}

function listing(name: string): Record<string, unknown> {
  const answer = run("archive_list.py", { path: join(fixtureDir, name) })
  expect(answer.body.ok, JSON.stringify(answer.body)).toBe(true)
  return answer.body
}

function destination(): string {
  const dir = mkdtempSync(join(tmpdir(), "archive-dest-"))
  created.push(dir)
  return dir
}

function extract(name: string, directory: string, overrides: Record<string, unknown> = {}) {
  const base = destination()
  return {
    base,
    answer: run("archive_extract.py", {
      path: join(fixtureDir, name),
      destination: base,
      directory,
      usedBytes: 0,
      quotaBytes: 104_857_600,
      maxFileBytes: 26_214_400,
      ...overrides,
    }),
  }
}

const created: string[] = []

beforeAll(() => {
  if (!AVAILABLE) return
  fixtureDir = mkdtempSync(join(tmpdir(), "archive-fixtures-"))
  scratch = mkdtempSync(join(tmpdir(), "archive-scratch-"))
  created.push(fixtureDir, scratch)
  const built = spawnSync(PYTHON, ["-c", FIXTURES, fixtureDir], { encoding: "utf8" })
  expect(built.status, built.stderr).toBe(0)
}, 120_000)

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!AVAILABLE)("archive_list.py", () => {
  it("lists nested directories, unicode names and totals", () => {
    const answer = listing("plain.zip")
    const entries = answer.entries as Array<Record<string, unknown>>
    expect(entries.map((entry) => entry.name)).toEqual([
      "notes/",
      "notes/readme.txt",
      "notes/unicode-ü-日本語.txt",
      "data.csv",
    ])
    expect(entries[0]).toMatchObject({ directory: true, size: 0 })
    expect(entries[2]).toMatchObject({ directory: false, size: 8 })
    expect(answer.totals).toMatchObject({
      entries: 4,
      files: 3,
      directories: 1,
      uncompressedBytes: 30,
    })
    expect((answer.entries as Array<Record<string, unknown>>)[2]?.compressedSize).toBeGreaterThan(0)
  })

  it("refuses unsafe names, symlinks, duplicates, encryption and depth", () => {
    for (const name of ["traversal.zip", "absolute.zip", "drive.zip", "symlink.zip", "duplicate.zip"]) {
      expect(codeOf(run("archive_list.py", { path: join(fixtureDir, name) })), name).toBe("unsafe_entry")
    }
    expect(codeOf(run("archive_list.py", { path: join(fixtureDir, "deep.zip") }))).toBe("too_deep")
    expect(codeOf(run("archive_list.py", { path: join(fixtureDir, "encrypted.zip") }))).toBe("encrypted")
  })

  it("enforces the entry and uncompressed caps and the ratio guard", () => {
    expect(codeOf(run("archive_list.py", { path: join(fixtureDir, "many.zip") }))).toBe("too_many_entries")
    expect(codeOf(run("archive_list.py", { path: join(fixtureDir, "bomb.zip") }))).toBe("bomb")
  })

  it("maps a non-ZIP payload without a traceback", () => {
    const answer = run("archive_list.py", { path: join(fixtureDir, "notzip.zip") })
    expect(codeOf(answer)).toBe("bad_archive")
    expect(answer.stdout).not.toContain("Traceback")
    expect(answer.stderr).not.toContain("Traceback")
  })
})

describe.skipIf(!AVAILABLE)("archive_extract.py", () => {
  it("writes nested and unicode files into the chosen subdirectory", () => {
    const { base, answer } = extract("plain.zip", "bundle")
    expect(answer.body.ok, JSON.stringify(answer.body)).toBe(true)
    expect(answer.body).toEqual({
      ok: true,
      directory: "bundle",
      files: [
        { path: "notes/readme.txt", size: 14 },
        { path: "notes/unicode-ü-日本語.txt", size: 8 },
        { path: "data.csv", size: 8 },
      ],
      bytes: 30,
    })
    expect(readFileSync(join(base, "bundle", "notes", "readme.txt"), "utf8")).toBe("hello archive\n")
    expect(readFileSync(join(base, "bundle", "notes", "unicode-ü-日本語.txt"), "utf8")).toBe("unicode\n")
    expect(statSync(join(base, "bundle", "data.csv")).mode & 0o777).toBe(0o600)
  })

  it("never writes through a traversal entry or follows a symlink entry", () => {
    const traversal = extract("traversal.zip", "bundle")
    expect(codeOf(traversal.answer)).toBe("unsafe_entry")
    expect(existsSync(join(traversal.base, "escape.txt"))).toBe(false)

    const symlink = extract("symlink.zip", "bundle")
    expect(codeOf(symlink.answer)).toBe("unsafe_entry")
    expect(readdirSync(symlink.base)).toEqual([])
  })

  it("refuses an existing target without partial output", () => {
    const base = destination()
    mkdirSync(join(base, "bundle", "notes"), { recursive: true })
    writeFileSync(join(base, "bundle", "notes", "readme.txt"), "keep me")

    const answer = run("archive_extract.py", {
      path: join(fixtureDir, "plain.zip"),
      destination: base,
      directory: "bundle",
      usedBytes: 0,
      quotaBytes: 104_857_600,
      maxFileBytes: 26_214_400,
    })
    expect(codeOf(answer)).toBe("already_exists")
    expect(readFileSync(join(base, "bundle", "notes", "readme.txt"), "utf8")).toBe("keep me")
    expect(existsSync(join(base, "bundle", "data.csv"))).toBe(false)
    expect(existsSync(join(base, "bundle", "notes", "unicode-ü-日本語.txt"))).toBe(false)
    expect(readdirSync(base)).toEqual(["bundle"])
  })

  it("enforces the chat quota before writing", () => {
    const { base, answer } = extract("plain.zip", "bundle", {
      usedBytes: 104_857_600 - 10,
    })
    expect(codeOf(answer)).toBe("quota_exceeded")
    expect(readdirSync(base)).toEqual([])
  })

  it("enforces the per-file cap and refuses a ratio bomb", () => {
    const big = extract("big.zip", "bundle")
    expect(codeOf(big.answer)).toBe("file_too_large")
    expect(readdirSync(big.base)).toEqual([])

    const bomb = extract("bomb.zip", "bundle")
    expect(codeOf(bomb.answer)).toBe("bomb")
    expect(readdirSync(bomb.base)).toEqual([])
  })

  it("rejects an invalid subdirectory name before touching the disk", () => {
    for (const directory of ["..", ".", "a/b", "-dash", ""]) {
      const { base, answer } = extract("plain.zip", directory)
      expect(codeOf(answer), directory).toBe("invalid_input")
      expect(readdirSync(base)).toEqual([])
    }
  })
})

describe.skipIf(!AVAILABLE)("tool wiring against the real scripts", () => {
  it("lists and extracts a chat ZIP through the tool layer", async () => {
    const root = mkdtempSync(join(tmpdir(), "archive-wiring-"))
    created.push(root)
    const files = join(root, "chats", "session-1", "files")
    mkdirSync(files, { recursive: true, mode: 0o700 })
    copyFileSync(join(fixtureDir, "plain.zip"), join(files, "bundle.zip"))

    const unused: PythonRunner = async () => {
      throw new Error("the archive tools must not use the file runner")
    }
    const deps = {
      bffUrl: "http://127.0.0.1:8787",
      token: "test-token",
      runner: unused,
      archiveRunner: createArchiveRunner({ python: PYTHON }),
      workspaceDir: root,
    }

    const listed = await runDocumentTool(
      "archive_list",
      { zipPath: "session-1/files/bundle.zip" },
      deps,
    )
    expect(listed.ok).toBe(true)
    if (listed.ok && !isToolSuccess(listed.value) && listed.value.kind === "listing") {
      expect(listed.value.zip).toBe("bundle.zip")
      expect(listed.value.entries).toHaveLength(4)
    } else {
      throw new Error("expected a listing")
    }

    const extracted = await runDocumentTool(
      "archive_extract",
      { zipPath: "session-1/files/bundle.zip", directory: "bundle" },
      deps,
    )
    expect(extracted.ok).toBe(true)
    expect(readFileSync(join(files, "bundle", "notes", "readme.txt"), "utf8")).toBe("hello archive\n")

    const again = await runDocumentTool(
      "archive_extract",
      { zipPath: "session-1/files/bundle.zip", directory: "bundle" },
      deps,
    )
    expect(again).toEqual({
      ok: false,
      error: "already_exists: the target exists; choose another directory",
    })
  })
})
