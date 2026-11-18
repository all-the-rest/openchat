import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createArchiveRunner } from "../src/runner-archive"
import type { ProcessResult, SpawnFn } from "../src/runner"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "python-tool-archive-runner-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

function withSpawn(result: ProcessResult): SpawnFn {
  return async () => result
}

const LISTING = {
  ok: true,
  bytes: 100,
  entries: [{ name: "a.txt", size: 3, compressedSize: 3, directory: false }],
  totals: { entries: 1, files: 1, directories: 0, uncompressedBytes: 3, compressedBytes: 3 },
}

describe("archive runner", () => {
  it("parses a listing body and removes the temporary directory", async () => {
    const tempRoot = await root()
    const run = createArchiveRunner({
      tempRoot,
      spawn: withSpawn({ code: 0, stdout: JSON.stringify(LISTING), stderr: "", timedOut: false }),
    })
    expect(await run("archive_list", { path: "/workspace/chats/s/files/a.zip" })).toEqual({
      ok: true,
      value: {
        kind: "listing",
        bytes: 100,
        entries: LISTING.entries,
        totals: LISTING.totals,
      },
    })
    expect(await readdir(tempRoot)).toEqual([])
  })

  it("rejects a malformed body without leaking it", async () => {
    const tempRoot = await root()
    const run = createArchiveRunner({
      tempRoot,
      spawn: withSpawn({
        code: 0,
        stdout: '{"ok":true,"bytes":1,"entries":[{"name":"../x","size":-1}],"totals":{}}',
        stderr: "",
        timedOut: false,
      }),
    })
    expect(await run("archive_list", {})).toEqual({
      ok: false,
      error: "internal: the archive tool answered an unexpected body",
    })
  })

  it("rejects an extraction path that could escape the folder", async () => {
    const tempRoot = await root()
    const run = createArchiveRunner({
      tempRoot,
      spawn: withSpawn({
        code: 0,
        stdout:
          '{"ok":true,"directory":"bundle","files":[{"path":"../escape.txt","size":1}],"bytes":1}',
        stderr: "",
        timedOut: false,
      }),
    })
    expect((await run("archive_extract", {})).ok).toBe(false)
  })

  it("maps a structured refusal to its fixed sentence", async () => {
    const tempRoot = await root()
    const run = createArchiveRunner({
      tempRoot,
      spawn: withSpawn({
        code: 1,
        stdout: '{"ok":false,"code":"bomb"}',
        stderr: "secret traceback",
        timedOut: false,
      }),
    })
    expect(await run("archive_list", {})).toEqual({
      ok: false,
      error: "archive: refused as a likely zip bomb",
    })
  })

  it("maps a timeout and a killed output stream", async () => {
    const tempRoot = await root()
    const timeout = createArchiveRunner({
      tempRoot,
      spawn: withSpawn({ code: null, stdout: "", stderr: "", timedOut: true }),
    })
    expect(await timeout("archive_list", {})).toEqual({
      ok: false,
      error: "timeout: the document tool did not finish in 30 s",
    })
    const flood = createArchiveRunner({
      tempRoot,
      spawn: withSpawn({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        failure: "output",
      }),
    })
    expect(await flood("archive_list", {})).toEqual({
      ok: false,
      error: "internal: the document tool produced too much output",
    })
  })
})
